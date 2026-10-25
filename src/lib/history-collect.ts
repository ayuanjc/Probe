/**
 * 把事件流折成一条历史记录。
 *
 * 为什么单独一个文件、为什么是纯函数：
 *   1. 路由里那两个 for-await 循环已经够长了，再塞十几个 if 就没人读得懂；
 *   2. 这里是「存什么」的唯一裁决处（只存索引，不存正文），
 *      纯函数才能在测试里把「模型吐了奇怪形状」全试一遍而不用起一条流水线。
 *
 * 所有 observe / toQuery 都对畸形输入沉默（类型不对就当没看见）：
 * 历史是附加价值，不能让它把一次正常提问搞挂。
 */
import { hashText, historyEnabled, saveQuery, type NewQuery, type SavedSource } from "@/lib/history-store";

type AnyEvent = { event: string; data: unknown };

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
}

function str(v: unknown, cap: number): string | null {
  return typeof v === "string" && v.trim() ? v.trim().slice(0, cap) : null;
}

export type SearchTrace = {
  intentKind: string | null;
  entities: string[];
  summaryLen: number;
  claimCount: number;
  degraded: string[];
  sources: SavedSource[];
  elapsedMs: number;
  /** 拿到 done 才算这一轮跑完了。没跑完的记录也存，但 elapsedMs 记 0。 */
  sawDone: boolean;
};

export function newSearchTrace(): SearchTrace {
  return { intentKind: null, entities: [], summaryLen: 0, claimCount: 0, degraded: [], sources: [], elapsedMs: 0, sawDone: false };
}

/**
 * 观察一个搜索事件。只认五种：intent / text.delta / sources / done / figures（忽略）。
 * sources 里要有 owner、quote —— quote 只存 hash，正文永不落库。
 */
export function observeSearchEvent(trace: SearchTrace, ev: AnyEvent): void {
  const data = asRecord(ev.data);
  if (!data) return;

  if (ev.event === "intent") {
    trace.intentKind = str(data.kind, 32);
    const ents = Array.isArray(data.entities) ? data.entities : [];
    for (const e of ents) {
      const name = str(asRecord(e)?.name, 60);
      if (name && !trace.entities.includes(name) && trace.entities.length < 8) trace.entities.push(name);
    }
    return;
  }

  if (ev.event === "text.delta") {
    const delta = typeof data.delta === "string" ? data.delta : "";
    // 摘要长度只用来在列表里区分「一句话」和「一整段」，不需要精确到字。
    if (trace.summaryLen < 20_000) trace.summaryLen += delta.length;
    return;
  }

  if (ev.event === "sources") {
    const rows = Array.isArray(data.sources) ? data.sources : [];
    for (const row of rows) {
      const s = asRecord(row);
      const url = str(s?.url, 2_000);
      if (!url) continue;
      if (trace.sources.length >= 30) break;
      trace.sources.push({
        url,
        title: str(s?.title, 300),
        provider: str(s?.owner, 24) ?? "unknown",
        quoteHash: typeof s?.quote === "string" && s.quote ? hashText(s.quote) : null,
      });
    }
    return;
  }

  if (ev.event === "done") {
    trace.sawDone = true;
    const elapsed = Number(data.elapsedMs);
    trace.elapsedMs = Number.isFinite(elapsed) && elapsed > 0 ? Math.floor(elapsed) : 0;
    trace.claimCount = Array.isArray(data.claims) ? data.claims.length : 0;
    if (Array.isArray(data.degraded)) {
      for (const d of data.degraded) {
        const code = str(d, 60);
        if (code && !trace.degraded.includes(code) && trace.degraded.length < 20) trace.degraded.push(code);
      }
    }
  }
}

export type RecordContext = { userId: string; query: string; region: string; modelHost: string | null };

export function searchTraceToQuery(trace: SearchTrace, ctx: RecordContext): NewQuery | null {
  // 一条事件都没看到（比如一上来就断开）不必留痕 —— 它不会给用户任何信息。
  if (!trace.sawDone && trace.sources.length === 0 && !trace.intentKind) return null;
  return {
    userId: ctx.userId,
    query: ctx.query,
    region: ctx.region,
    modelHost: ctx.modelHost,
    intentKind: trace.intentKind,
    entities: trace.entities,
    summaryLen: trace.summaryLen,
    claims: trace.claimCount,
    // 搜索阶段没有判定：判不判定是 /api/evidence 里的另一趟事。
    // 存 0 而不是编一个数，列表里会显示「未核验」。
    supported: 0,
    contradicted: 0,
    unknownN: 0,
    degraded: trace.degraded,
    sources: trace.sources,
    elapsedMs: trace.elapsedMs,
  };
}

export type VerifyTrace = {
  title: string | null;
  chars: number;
  claims: number;
  supported: number;
  contradicted: number;
  unknownN: number;
  degraded: string[];
  elapsedMs: number;
  docHash: string | null;
};

export function newVerifyTrace(): VerifyTrace {
  return { title: null, chars: 0, claims: 0, supported: 0, contradicted: 0, unknownN: 0, degraded: [], elapsedMs: 0, docHash: null };
}

export function observeVerifyEvent(trace: VerifyTrace, ev: AnyEvent): void {
  const data = asRecord(ev.data);
  if (!data) return;

  if (ev.event === "doc.parsed") {
    trace.title = str(data.title, 300);
    const chars = Number(data.chars);
    trace.chars = Number.isFinite(chars) && chars > 0 ? Math.floor(chars) : 0;
    return;
  }

  if (ev.event === "claim.extracted") {
    trace.claims = Number(trace.claims) || 0;
    return;
  }

  if (ev.event === "done") {
    const scores = asRecord(data.scores);
    const counts = asRecord(scores?.counts);
    const n = (v: unknown) => {
      const x = Number(v);
      return Number.isFinite(x) && x > 0 ? Math.floor(x) : 0;
    };
    trace.supported = n(counts?.supported);
    trace.contradicted = n(counts?.contradicted);
    trace.unknownN = n(counts?.unverified);
    trace.claims = Math.max(trace.claims, n(counts?.verifiable) + n(counts?.unverifiable));
    const elapsed = Number(data.elapsedMs);
    trace.elapsedMs = Number.isFinite(elapsed) && elapsed > 0 ? Math.floor(elapsed) : 0;
    if (Array.isArray(data.degraded)) {
      for (const d of data.degraded) {
        const code = str(d, 60);
        if (code && !trace.degraded.includes(code) && trace.degraded.length < 20) trace.degraded.push(code);
      }
    }
  }
}

export function verifyTraceToQuery(trace: VerifyTrace, ctx: RecordContext & { body?: string }): NewQuery | null {
  // 一篇什么都没核出来的文章也值得留一条 —— 用户点回来能看见「当时就是这样」。
  // 但没有 doc.parsed 说明连正文都没拿到，那不留。
  if (!trace.title && trace.chars === 0) return null;
  return {
    userId: ctx.userId,
    // 正文可能是链接抓来的，标题要兜一个占位，否则列表里是一行空白。
    query: trace.title ?? ctx.query ?? "（无标题文档）",
    region: ctx.region,
    modelHost: ctx.modelHost,
    intentKind: "verify",
    entities: [],
    summaryLen: trace.chars,
    claims: trace.claims,
    supported: trace.supported,
    contradicted: trace.contradicted,
    unknownN: trace.unknownN,
    degraded: trace.degraded,
    // 核验不存信源行：那批证据是留出集的临时结果，存下来等于把「读过什么」也交了。
    sources: [],
    docHash: trace.docHash ?? (ctx.body ? hashText(ctx.body) : null),
    elapsedMs: trace.elapsedMs,
  };
}

/**
 * 落库的唯一入口。写失败只 warn，不抛 —— 调用点都在流的 finally 里，
 * 那里抛出会盖掉已经上屏的内容。
 */
export function persistQuietly(input: NewQuery | null, where: string): string | null {
  if (!input) return null;
  if (!historyEnabled()) return null;
  try {
    return saveQuery(input);
  } catch (err) {
    console.warn("[history] " + where + " 写入失败：", err instanceof Error ? err.message : err);
    return null;
  }
}
