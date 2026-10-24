/**
 * 译文获取 + 分段 + 打分。全部在服务端跑：浏览器直连第三方翻译接口会被 CORS 挡住，
 * 而且把密钥和限流放在客户端等于没有。
 *
 * 引擎优先级：有 OPENAI_API_KEY 用模型 → 否则用 MyMemory 公共接口 → 都没有就只给原文分段。
 * 三种情况都要在 UI 上如实标注 —— 「谁翻的」和「翻得准不准」是两件事。
 */

import { z } from "zod";
import { getDirect } from "./http";
import { generateStructured } from "./llm";
import { LANG_NAME, detectLang, memPair, needsTranslation, targetFor, type LangCode } from "./lang";
import { overallRisk, translationRisk, type RiskScore } from "./translate-risk";
import type { DocSource, TranslateResponse, TranslatedSegment } from "./translate-types";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36";

const FETCH_TIMEOUT_MS = 8000;
const TRANSLATE_TIMEOUT_MS = 7000;
const DOC_MAX_CHARS = 6000;
const MAX_SEGMENTS = 48;
const SEG_TARGET_CHARS = 260;

type Fetched = { ok: boolean; text: string; title: string; reason?: string; truncated?: boolean };


function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d{1,6});/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]{1,5});/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)));
}

function toText(html: string): { title: string; body: string } {
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const title = titleMatch ? decodeEntities(titleMatch[1].replace(/\s+/g, " ")).trim() : "";

  const cleaned = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|iframe|form|nav|header|footer|aside)[^>]*>[\s\S]*?<\/\1>/gi, " ");

  // 有 <article> 就只读它，退而求其次读 <p>。
  const article = /<article[^>]*>([\s\S]*?)<\/article>/i.exec(cleaned);
  const scoped = article ? article[1] : cleaned;

  const paras = [...scoped.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)].map((m) => m[1]);
  // 段落里还夹着内联标签（<a>/<code>/<em>）：不在这里剥掉，正文里就会混进
  // "href=\"https://…\"" 这种残渣，然后被当成"未译片段"记到歧义分上。
  const body =
    paras.length > 0
      ? paras.join("\n\n")
      : scoped.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, " ");

  const text = decodeEntities(body)
    .replace(/<[^>]*>/g, " ")
    // 残缺 HTML（未闭合的 <a href="…"）被剥标签后只剩属性名和值
    .replace(/\b(?:href|src|rel|class|title|alt|target|id)=["'][^"']*["']/gi, " ")
    .replace(/\r/g, "")
    .replace(/[ \t\u00a0]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join("\n")
    .trim();

  return { title, body: text };
}

export async function fetchArticle(url: string): Promise<Fetched> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, text: "", title: "", reason: "url_invalid" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, text: "", title: "", reason: "url_invalid" };
  }

  {
    const rep = await getDirect(parsed.toString(), {
      timeoutMs: FETCH_TIMEOUT_MS,
      headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml" },
      maxBytes: 3_000_000,
    });
    if (!rep.ok) {
      // http.ts 是访客闸门：它按解析出的 IP 判私网，并逐跳复检重定向。
      // 这里的两个新原因折回既有口径，UI 的 degraded 文案不用跟着改。
      const reason =
        rep.reason === "host_blocked" ? "url_blocked" :
        rep.reason === "invalid_redirect" ? "fetch_failed" :
        rep.reason;
      return { ok: false, text: "", title: "", reason };
    }
    if (rep.status >= 400) return { ok: false, text: "", title: "", reason: "http_" + rep.status };

    const type = rep.contentType;
    const raw = rep.body;
    if (!type.includes("html") && !type.includes("xml") && !type.includes("text/plain")) {
      return { ok: false, text: "", title: "", reason: "not_html" };
    }

    const { title, body } = toText(raw);
    if (body.length < 120) return { ok: false, text: "", title, reason: "too_short" };

    const truncated = body.length > DOC_MAX_CHARS;
    return { ok: true, text: truncated ? body.slice(0, DOC_MAX_CHARS) : body, title, truncated };
  }
}

/** 按段落 → 句子切分。太短的句子并回上一段，避免出现"一句话一个卡片"。 */
export function splitSegments(text: string, max = MAX_SEGMENTS): { segments: string[]; truncated: boolean } {
  const clean = text.replace(/\r/g, "").replace(/[ \t]+/g, " ").trim();
  const paras = clean.split(/\n{1,}/).map((p) => p.trim()).filter((p) => p.length > 0);

  const pieces: string[] = [];
  for (const para of paras) {
    let buf = "";
    for (let i = 0; i < para.length; i++) {
      buf += para[i];
      const ch = para[i];
      const endOfSentence = ch === "。" || ch === "！" || ch === "？" || ch === "；" || ch === "!" || ch === "?" || ch === ";";
      const dotEnd = ch === "." && (para[i + 1] === " " || i === para.length - 1) && buf.length > 30;
      if ((endOfSentence || dotEnd) && buf.trim().length >= 40) {
        pieces.push(buf.trim());
        buf = "";
      }
    }
    if (buf.trim().length > 0) {
      const tail = buf.trim();
      if (pieces.length > 0 && tail.length < 40) pieces[pieces.length - 1] += " " + tail;
      else pieces.push(tail);
    }
  }

  const merged: string[] = [];
  for (const p of pieces) {
    if (p.length <= SEG_TARGET_CHARS) {
      merged.push(p);
    } else {
      // 超长句子按字数硬切，切点尽量落在逗号后。
      let rest = p;
      while (rest.length > SEG_TARGET_CHARS) {
        const window = rest.slice(0, SEG_TARGET_CHARS);
        const cut = Math.max(window.lastIndexOf("，"), window.lastIndexOf(","), window.lastIndexOf(" "));
        const at = cut > SEG_TARGET_CHARS * 0.6 ? cut + 1 : SEG_TARGET_CHARS;
        merged.push(rest.slice(0, at).trim());
        rest = rest.slice(at).trim();
      }
      if (rest.length > 0) merged.push(rest);
    }
  }

  const truncated = merged.length > max;
  return { segments: truncated ? merged.slice(0, max) : merged, truncated };
}

/* ------------------------------- 引擎 ------------------------------- */

const memCache = new Map<string, { dst: string; at: number }>();
const MEM_TTL_MS = 15 * 60_000;
const MEM_MAX = 800;

function cacheGet(key: string): string | null {
  const hit = memCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > MEM_TTL_MS) {
    memCache.delete(key);
    return null;
  }
  return hit.dst;
}

function cacheSet(key: string, dst: string): void {
  // 满了扔最老的一半，而不是清空整张表：清空等于让正在读的那篇文档
  // 在下一段又把翻过的句子全再翻一遍（MyMemory 有每日配额）。
  if (memCache.size >= MEM_MAX) {
    let drop = Math.ceil(MEM_MAX / 2);
    for (const k of memCache.keys()) {
      memCache.delete(k);
      if (--drop <= 0) break;
    }
  }
  memCache.set(key, { dst, at: Date.now() });
}

type MemReply = { translatedText?: string; quotaFinished?: boolean; responseStatus?: number | string };

async function memTranslateOne(text: string, pair: string): Promise<string> {
  const key = pair + "\u0000" + text;
  const cached = cacheGet(key);
  if (cached) return cached;

  const url =
    "https://api.mymemory.translated.net/get?q=" +
    encodeURIComponent(text.slice(0, 480)) +
    "&langpair=" +
    encodeURIComponent(pair);

  // 公共接口偶发抽风，一次失败就判整个引擎不可用太脆：给它第二次机会。
  let lastError = "mymemory_failed";
  for (let attempt = 0; attempt < 2; attempt++) {
    const rep = await getDirect(url, {
      timeoutMs: TRANSLATE_TIMEOUT_MS,
      headers: { accept: "application/json" },
      maxBytes: 400_000,
    });
    if (!rep.ok) {
      lastError = "mymemory_" + rep.reason;
      continue;
    }
    if (rep.status >= 400) {
      lastError = "mymemory_http_" + rep.status;
      continue;
    }

    let json: { responseData?: MemReply; quotaFinished?: boolean; responseStatus?: number };
    try {
      json = JSON.parse(rep.body) as typeof json;
    } catch {
      lastError = "mymemory_bad_json";
      continue;
    }
    if (json.quotaFinished) throw new Error("mymemory_quota");
    const dst = json.responseData?.translatedText ?? "";
    if (!dst.trim()) {
      lastError = "mymemory_empty";
      continue;
    }
    // 上游偶尔把错误串塞进 translatedText（"MYMEMORY WARNING: ..."）
    if (/MYMEMORY WARNING|QUERY LENGTH LIMIT|INVALID/i.test(dst)) throw new Error("mymemory_refused");
    cacheSet(key, dst);
    return dst;
  }
  throw new Error(lastError);
}

async function memTranslateAll(
  segments: string[],
  pair: string,
): Promise<{ dsts: string[]; failed: number; reason?: string }> {
  const dsts = new Array<string>(segments.length).fill("");
  let failed = 0;
  let reason: string | undefined;

  let cursor = 0;
  const workers = new Array(Math.min(3, segments.length)).fill(0).map(async () => {
    while (cursor < segments.length) {
      const i = cursor++;
      try {
        dsts[i] = await memTranslateOne(segments[i], pair);
      } catch (err) {
        failed++;
        reason = err instanceof Error ? err.message : "mymemory_failed";
      }
    }
  });
  await Promise.all(workers);
  return { dsts, failed, reason };
}

const TranslationSchema = z.object({
  items: z.array(z.object({ i: z.number().int().min(0), dst: z.string() })),
});

async function llmTranslateAll(segments: string[], from: LangCode, to: LangCode): Promise<string[] | null> {
  const numbered = segments.map((s, i) => i + 1 + ". " + s).join("\n");
  const out = await generateStructured({
    schema: TranslationSchema,
    system:
      "你是翻译器，不是编辑。逐条把编号句子译成目标语言，保留所有数字、专名、引号内原话与不确定语气（may/could/据称）。" +
      "不要合并、不要删减、不要补充解释，不要改写成更通顺的版本。i 从 0 开始，与输入编号一一对应。",
    prompt:
      "目标语言：" + LANG_NAME[to].zh + "（" + to + "）\n源语言：" + LANG_NAME[from].zh + "\n\n" + numbered,
  });
  if (!out) return null;
  const dsts = new Array<string>(segments.length).fill("");
  for (const item of out.items) {
    if (item.i >= 0 && item.i < segments.length) dsts[item.i] = item.dst.trim();
  }
  return dsts.some((d) => d.length > 0) ? dsts : null;
}

/* ------------------------------ 主入口 ------------------------------ */

export type TranslateInput = { url?: string; title?: string; text?: string };

export async function translateDocument(input: TranslateInput): Promise<TranslateResponse> {
  const url = (input.url ?? "").trim();
  const title = (input.title ?? "").trim();

  const provided = (input.text ?? "").trim();
  let docSource: DocSource = provided.length >= 120 ? "provided" : "snippet";
  let body = provided;
  let docTitle = title;
  let fetchedTruncated = false;
  let fetchReason: string | undefined;
  const degraded: string[] = [];

  // 有 url 就先试着抓全文：摘要只有一两句，看不见全文的语序和限定条件，
  // 对照的意义就没了。抓不到才退回摘要 —— 但要在界面上说清楚只对照了片段。
  if (url) {
    const got = await fetchArticle(url);
    if (got.ok) {
      docSource = "fetched";
      body = got.text;
      fetchedTruncated = Boolean(got.truncated);
      if (!docTitle) docTitle = got.title;
    } else {
      fetchReason = got.reason;
      degraded.push("fetch:" + (got.reason ?? "failed"));
    }
  }

  if (!body) body = title;
  if (!body) {
    return { ok: false, error: "no_text", message: "这条信源没有可对照的正文，也没有标题。" };
  }

  const from = detectLang(title + " " + body.slice(0, 600));
  const to = targetFor(from);
  const translatedNeeded = needsTranslation(from, to);

  const split = splitSegments(body);
  const segments = split.segments;
  if (split.truncated) degraded.push("segments:capped");

  const base = {
    ok: true as const,
    title: docTitle || url,
    url,
    from,
    to,
    fromName: LANG_NAME[from].zh,
    toName: LANG_NAME[to].zh,
    needsTranslation: translatedNeeded,
    docSource,
    chars: body.length,
    truncated: fetchedTruncated || split.truncated,
    degraded,
  };

  if (!translatedNeeded) {
    /**
     * 「不需要翻译」有两种，不能共用一句话：
     * - 原文就是中文 → 确实无需翻译；
     * - 语言没认出来（短标题、中英混排）→ 是没识别出来，不是不需要。
     * 旧文案把后者也说成「原文已是目标语言」，等于替用户下了个错结论。
     */
    const unknownLang = from === "unknown";
    if (unknownLang) degraded.push("lang:unknown");
    const segs: TranslatedSegment[] = segments.map((src, i) => ({
      i,
      src,
      dst: "",
      risk: 0,
      band: "low" as const,
      signals: [
        {
          code: unknownLang ? "lang_unknown" : "noop",
          label: unknownLang ? "没认出原文语言，未翻译" : "原文已是目标语言，未翻译",
          weight: 0,
        },
      ],
    }));
    return {
      ...base,
      engine: "none",
      engineNote: unknownLang
        ? "没认出原文语言（可能是短标题或中英混排），只做分段。"
        : "原文即目标语言，未调用翻译引擎。",
      segments: segs,
      overall: { risk: 0, band: "low", signals: [] },
    };
  }

  const pair = memPair(from, to);
  let engine: "llm" | "mymemory" | "none" = "none";
  let engineNote = "";
  let dsts: string[] = new Array(segments.length).fill("");

  const llm = await llmTranslateAll(segments, from, to);
  if (llm) {
    engine = "llm";
    engineNote = "模型逐段翻译（保留数字与专名，不改写）";
    dsts = llm;
  } else if (pair) {
    const mem = await memTranslateAll(segments, pair);
    if (mem.failed === segments.length) {
      degraded.push("engine:unavailable");
      engineNote = "翻译引擎不可用，仅展示原文分段。";
    } else {
      engine = "mymemory";
      engineNote = "MyMemory 公共翻译接口（机器翻译，未做人工校对）";
      dsts = mem.dsts;
      if (mem.failed > 0) degraded.push("engine:partial_" + mem.failed + "of" + segments.length);
    }
  } else {
    degraded.push("engine:langpair_unsupported");
    engineNote = "该语言对没有可用引擎，仅展示原文分段。";
  }

  if (fetchReason) {
    degraded.push("doc:title_only");
  }

  const scores: RiskScore[] = [];
  const segs: TranslatedSegment[] = segments.map((src, i) => {
    const dst = dsts[i] ?? "";
    // 引擎挂了却没译出来，不能记 0 分：0 分在界面上是"没问题"，
    // 而这一段恰恰是最该被怀疑的 —— 用户看到的是中文标题 + 英文正文。
    const score: RiskScore = dst
      ? translationRisk(src, dst, from)
      : engine === "none"
        ? { risk: 0, band: "low", signals: [] }
        : {
            risk: 1,
            band: "high",
            signals: [{ code: "segment_untranslated", label: "该段未翻成，保留原文", weight: 1 }],
          };
    scores.push(score);
    return { i, src, dst, risk: score.risk, band: score.band, signals: score.signals };
  });

  return {
    ...base,
    engine,
    engineNote,
    segments: segs,
    /**
     * 分母是**全部分段**，不是「出问题的那些段」。
     * 拿问题段求平均时，48 段里错 1 段与 48 段全错会出同一个数，
     * 而界面上写的是「平均歧义」 —— 那是把最坏情况说成普遍情况。
     */
    overall: overallRisk(scores),
  };
}
