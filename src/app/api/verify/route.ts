import { createHash } from "node:crypto";
import { z } from "zod";
import { prepareRuntimeConfig, regionSummary, withRuntimeConfig } from "@/lib/runtime-config";
import { encodeVerifyEvent, type VerifyEvent } from "@/lib/verify-events";
import { runVerify } from "@/agents/verify-pipeline";
import { createGate, createLimiter, readPositiveInt } from "@/lib/rate-limit";
import { clientKey, isCrossSite, jsonError, publicMessage, rateLimited, readJsonBody } from "@/lib/request-guard";
import { requireUser } from "@/lib/auth/guard";
import { usageAccumulator } from "@/lib/metrics";
import { runWithCallScope, type CallScope } from "@/lib/call-scope";
import { chargeOperation, OP_UNITS } from "@/lib/llm";
import { recordDegraded, recordOp } from "@/lib/ops-counters";
import {
  newVerifyTrace,
  observeVerifyEvent,
  persistQuietly,
  verifyTraceToQuery,
  type RecordContext,
} from "@/lib/history-collect";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 文档核验接口：POST { text } 或 POST { url }，SSE 回流。
 *
 * 与 /api/search 共用同一套限流写法，但**两套桶**：搜索是按次用的，核验一次可能跑
 * 一两分钟、几十上百次上游调用，混在一个桶里要么把搜索卡死，要么让核验无限制地烧钱。
 *
 * 默认 2 次/分钟。这个数字不是拍脑袋：一篇 4 万字的核验自身就要 60-90 秒，
 * 一分钟能发出去的第二次请求基本等于并发双跑，除了烧 key 没有别的作用。
 */
const perClient = createLimiter({
  name: "verify",
  limit: readPositiveInt("PROBE_VERIFY_RATE_PER_MIN", 2),
});

/** 换 IP 就绕开 per-IP 额度，所以还要一道进程级总闸。 */
const globalLimiter = createLimiter({
  name: "verify-global",
  limit: readPositiveInt("PROBE_GLOBAL_VERIFY_PER_MIN", 12),
});

/** 核验一次几十秒且吃外部调用，并发必须卡死，超出直接 503。 */
const gate = createGate(readPositiveInt("PROBE_VERIFY_CONCURRENCY", 2));

/** 正文上限 80_000 字，中文按 3 字节/字算约 240KB，留余量到 400KB。 */
const MAX_BODY_BYTES = 400_000;

/**
 * 匿名核验（/check 公开页）。
 *
 * 为什么单独一套闸：登录态的额度是「按人记账」，这里的成本是「按次烧钱」——
 * 一个陌生人不登录就能让服务端起一轮几十次上游调用。所以：
 *   - 只收正文，不代抓链接（抓链接等于给任何人一个免费代理）；
 *   - 一次最多 2000 字（够核一条说法，不够核一整篇稿）；
 *   - 每 IP 每分钟 1 次、全进程每天 N 次（默认 40）—— 用完就明天再来，不是"关站"；
 *   - 必须显式带 x-probe-anon: 1，否则照旧 401：让"想匿名"是一个主动动作，
 *     而不是任何漏了 cookie 的请求都自动掉进这条更贵的路径。
 */
const ANON_MAX_CHARS = 2_000;
/**
 * 匿名最少多少字。与 verify-doc 的 120 对齐，而不是自己定 60：
 * 两道门槛不一致时，用户会在 60–119 字之间拿到「正文不足 120 字」，
 * 而页面上写的是「至少 60 字」—— 自己的文案和自己的校验互相打脸。
 */
const ANON_MIN_CHARS = 120;

const anonClient = createLimiter({
  name: "verify-anon",
  limit: readPositiveInt("PROBE_ANON_VERIFY_PER_MIN", 1),
});

const anonDaily = { day: "", used: 0 };

function anonEnabled(): boolean {
  return (process.env.PROBE_ANON_VERIFY ?? "1").trim() !== "0";
}

function anonDailyCap(): number {
  return readPositiveInt("PROBE_ANON_VERIFY_PER_DAY", 40, { max: 10_000 });
}

function takeAnonDaily(): { ok: boolean; used: number; cap: number } {
  // 按 UTC 日期翻页：跨时区时"今天"会各有各的定义，用 UTC 是为了全天一致。
  const day = new Date().toISOString().slice(0, 10);
  if (anonDaily.day !== day) {
    anonDaily.day = day;
    anonDaily.used = 0;
  }
  const cap = anonDailyCap();
  if (anonDaily.used >= cap) return { ok: false, used: anonDaily.used, cap };
  anonDaily.used += 1;
  return { ok: true, used: anonDaily.used, cap };
}

const Body = z.object({
  /** 4 万字上限在 verify-doc 里再收一次：这里放宽到 8 万字只为给出更好的报错。 */
  text: z.string().max(80_000).optional(),
  url: z.string().max(2048).optional(),
  /** 跳过缓存重跑。Phase 1 不读缓存，参数先收着，免得 Phase 2 改接口。 */
  fresh: z.boolean().optional(),
  /**
   * "sse"（默认）边跑边推；"json" 等全部跑完一次性返回。
   *
   * json 存在的理由只有验收：SSE 能被 curl 看见，但没法被脚本断言 ——
   * 想在 CI 里验「这篇的评级是不是 N/A」，解析 SSE 帧比自己实现一遍还费事。
   */
  format: z.enum(["sse", "json"]).optional(),
});

/**
 * 一次性返回：把整条流水线跑完之后挑出要点，**不**把事件流原样倒出来。
 *
 * 事件流里同一件事会出现三次（claim.extracted / evidence.retrieved / nli.verdict），
 * 脚本要的是「结论 + 可核对的账」，所以这里按 claim 归并。
 */
async function jsonResponse(
  input: { text?: string; url?: string },
  signal: AbortSignal,
  ctx: RecordContext,
): Promise<Response> {
  const events: VerifyEvent[] = [];
  let failure: string | null = null;
  const meter = usageAccumulator();
  const trace = newVerifyTrace();
  try {
    for await (const event of runVerify(input, signal, meter.sink)) {
      events.push(event);
      observeVerifyEvent(trace, event);
    }
  } catch (err) {
    failure = publicMessage(err, "核验过程中出错了，请稍后重试。");
  } finally {
    // 核验是几十次上游调用的长链路，账必须在收尾处落一行，否则线上没人知道烧了多少。
    console.info("[verify] usage", meter.read());
    recordDegraded(trace.degraded);
    // 匿名请求不落历史：history 是按账号存的，塞一条 user_id="" 进去只会污染表。
    if (ctx.userId) persistQuietly(verifyTraceToQuery(trace, { ...ctx, body: input.text }), "verify");
  }

  const doc = events.find((e) => e.event === "doc.parsed");
  const done = events.find((e) => e.event === "done");
  const err = events.find((e) => e.event === "error");
  const claims = events.flatMap((e) =>
    e.event === "claim.extracted"
      ? e.data.claims.map((c) => ({
          claimIndex: c.claimIndex,
          segmentIdx: e.data.segmentIdx,
          quote: c.quote,
          kind: c.kind,
          attr: c.attr,
          value: c.value,
          unit: c.unit ?? null,
          charStart: c.charStart,
          charEnd: c.charEnd,
        }))
      : [],
  );
  const dropped = events.flatMap((e) => (e.event === "claim.extracted" ? e.data.dropped.codes : []));
  const nli = events.flatMap((e) =>
    e.event === "nli.verdict"
      ? [{ claimIndex: e.data.claimIndex, evidenceId: e.data.evidenceId, label: e.data.label, authority: e.data.authority }]
      : [],
  );

  const message = err ? err.data.message : failure;
  const body = {
    ok: message === null && done !== undefined,
    ...(message ? { message } : {}),
    doc: doc ? doc.data : null,
    claims,
    dropped,
    nli,
    // scores 恒在 done 里：它是一个自包含的快照，单独发一次只是为了让 SSE 提前一格。
    scores: done ? done.data.scores : null,
    notes: done ? done.data.notes : [],
    degraded: done ? done.data.degraded : [],
    elapsedMs: done ? done.data.elapsedMs : null,
    stats: done ? done.data.stats : null,
  };
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}
function sseResponse(
  input: { text?: string; url?: string },
  signal: AbortSignal,
  release: () => void,
  scope: CallScope,
  ctx: RecordContext,
): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const meter = usageAccumulator();
      let closed = false;
      const push = (chunk: string): boolean => {
        if (closed) return false;
        try {
          controller.enqueue(encoder.encode(chunk));
          return true;
        } catch {
          closed = true;
          return false;
        }
      };
      const finish = () => {
        release();
        if (closed) return;
        closed = true;
        try {
          controller.close();
        } catch {
          // 已经关闭
        }
      };

      try {
        // 与 /api/search 同理：流的 start() 可能在路由返回之后才跑，
        // 额度要算在这个用户名下，就得在这里重新绑定一次上下文。
        await runWithCallScope(scope, async () => {
          const trace = newVerifyTrace();
          try {
            for await (const event of runVerify(input, signal, meter.sink)) {
              // 与搜索同理：历史只抄索引（标题、字数、三态计数），正文与证据原文永不落库。
              observeVerifyEvent(trace, event);
              // 断开即停：核验是长链路，用户关掉页面后继续跑几十次上游调用是纯浪费。
              if (!push(encodeVerifyEvent(event))) break;
            }
          } finally {
            recordDegraded(trace.degraded);
    // 匿名请求不落历史：history 是按账号存的，塞一条 user_id="" 进去只会污染表。
    if (ctx.userId) persistQuietly(verifyTraceToQuery(trace, { ...ctx, body: input.text }), "verify");
          }
        });
      } catch (err) {
        // 上游异常直接外发会泄露内部地址/模型名/响应片段，只回公共文案。
        const message = publicMessage(err, "核验过程中出错了，请稍后重试。");
        push(encodeVerifyEvent({ event: "error", data: { message } }));
      } finally {
        console.info("[verify] usage", meter.read());
        finish();
      }
    },
    cancel() {
      // 客户端断开由 push 失败兜住；槽位必须在这里也归还，
      // 否则长链路被反复掐断后并发闸门会被永久占满。
      release();
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}

async function guarded(
  request: Request,
  input: { text?: string; url?: string },
  format: "sse" | "json" = "sse",
  scope: CallScope,
): Promise<Response> {
  // 只有 "u:<id>" 这种 scope 才代表一个真实账号。匿名 scope 是 "anon:<hash>"，
  // 用 replace 会把整串当成 userId，结果匿名核验照样往 queries 表里写一行 —— 而且
  // user_id 就写着那个内存哈希。所以这里必须显式判断前缀，不能靠剥字符串。
  // 空串 = 没有账号，后面那两处 if (ctx.userId) 才会真的挡住它。
  const uid = scope.key.startsWith("u:") ? scope.key.slice(2) : "";
  const ctx: RecordContext = { userId: uid, query: "", region: "cn", modelHost: "" };
  if (isCrossSite(request)) return jsonError(403, "cross_site", "拒绝跨站调用。");

  const per = perClient.check(clientKey(request));
  if (!per.ok) {
    return rateLimited(per.retryAfterSeconds, `核验请求过于频繁，请 ${per.retryAfterSeconds} 秒后重试。`);
  }
  const all = globalLimiter.check("all");
  if (!all.ok) {
    return rateLimited(all.retryAfterSeconds, `当前核验请求量过大，请 ${all.retryAfterSeconds} 秒后重试。`);
  }

  const release = gate.acquire();
  if (!release) {
    return jsonError(503, "busy", "服务正忙，请稍后再试。", { "retry-after": "5" });
  }

  try {
    return await runWithCallScope(scope, async () => {
      // 一次核验记 3 点，而不是按它内部那二三十次上游调用记 ——
      // 否则用户会觉得「核验一次就吃掉八次提问的额度」，而且经常跑到一半被拦。
      const charged = chargeOperation(OP_UNITS.verify);
      recordOp("verify");
      if (!charged.ok) {
        console.info("[quota] " + scope.label + " 今日额度已用尽（" + charged.used + "/" + charged.cap + " 点），本轮核验降级为本地判定。");
      }
      const cfg = await prepareRuntimeConfig(request);
      // 区域在请求上下文里取一次：SSE 的 start() 可能在路由返回之后才跑，
      // 到那时再问「这次请求来自哪里」已经晚了（ALS 可能已经不在了）。
      const stamped = (): RecordContext => {
        const region = regionSummary();
        return { userId: ctx.userId, query: ctx.query || input.url || "", region: region.region, modelHost: region.modelHost };
      };
      if (format === "json") {
        try {
          return await withRuntimeConfig(cfg, () => jsonResponse(input, request.signal, stamped()));
        } finally {
          release();
        }
      }
      return withRuntimeConfig(cfg, () => sseResponse(input, request.signal, release, scope, stamped()));
    });
  } catch (err) {
    release();
    return jsonError(500, "internal", publicMessage(err, "核验启动失败，请稍后重试。"));
  }
}

/**
 * 匿名核验：只收正文、限长、限频、限日总量，且不落历史。
 *
 * 刻意不给匿名用户「代抓链接」：那等于开一个免费代理，而且抓取目标由请求方指定。
 */
async function anonVerify(request: Request, input: { text?: string; url?: string }): Promise<Response> {
  if (!anonEnabled()) {
    return jsonError(403, "anon_disabled", "未登录的核验已关闭，请登录后使用。");
  }
  if (input.url) {
    return jsonError(422, "anon_text_only", "未登录只能用正文核验，不代抓链接。登录后可以用链接。");
  }
  const text = (input.text ?? "").trim();
  if (text.length < ANON_MIN_CHARS) {
    return jsonError(422, "text_too_short", "至少贴 " + ANON_MIN_CHARS + " 字：太短的片段里没有可被外部证实的断言。");
  }
  if (text.length > ANON_MAX_CHARS) {
    return jsonError(422, "text_too_long", "未登录一次最多 " + ANON_MAX_CHARS + " 字，登录后支持 4 万字长文。");
  }
  const per = anonClient.check(clientKey(request));
  if (!per.ok) {
    return rateLimited(per.retryAfterSeconds, "未登录每分钟只能核验 1 次，请 " + per.retryAfterSeconds + " 秒后再试。");
  }
  const daily = takeAnonDaily();
  if (!daily.ok) {
    return rateLimited(3600, "今天公开核验的额度已用完（服务端每天限量，避免被刷成账单）。登录后用自己的额度。");
  }
  // 身份只用于额度与限流：一个不可逆的短哈希，不落盘、不进历史、不进日志。
  const digest = createHash("sha256").update(clientKey(request)).digest("hex").slice(0, 12);
  return guarded(request, { text }, "json", { key: "anon:" + digest, label: "匿名访客" });
}

export async function POST(request: Request) {
  if (isCrossSite(request)) return jsonError(403, "cross_site", "拒绝跨站调用。");
  // 匿名是一条**主动**路径：必须显式声明，避免任何丢了 cookie 的请求自动掉进来。
  const wantsAnon = request.headers.get("x-probe-anon") === "1";
  const auth = await requireUser(request);
  if (!auth.ok && !wantsAnon) return auth.response;

  // 限长读体：先挡住超大请求，再谈形状。
  const body = await readJsonBody(request, MAX_BODY_BYTES);
  if (!body.ok) return jsonError(body.status, body.code, body.message);

  const parsed = Body.safeParse(body.value);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return jsonError(
      422,
      "invalid_body",
      "请求形状不对：" + (first ? first.path.join(".") + " " + first.message : "未知字段错误"),
    );
  }
  const { text, url } = parsed.data;
  if (!auth.ok) return anonVerify(request, { text, url });
  const format = parsed.data.format ?? "sse";
  if (!text && !url) {
    return jsonError(422, "no_input", "要给正文，或给一个文章链接。");
  }
  return guarded(request, { text, url }, format, scopeOf(auth.user));
}

/** 额度计数的身份：登录态按账号（同一账号换 IP 也跑不掉）。 */
function scopeOf(user: { id: string; username: string }): CallScope {
  return { key: "u:" + user.id, label: "用户 " + user.username };
}

/** GET ?url=… 只为了 curl 验收方便，行为与 POST 完全一致。 */
export async function GET(request: Request) {
  const auth = await requireUser(request);
  if (!auth.ok) return auth.response;
  const url = new URL(request.url).searchParams.get("url") ?? "";
  if (!url) {
    return jsonError(422, "no_input", "要给 ?url= 参数。");
  }
  // ?format=json 让 curl 直接拿到可断言的对象（GET 本来就是为了验收方便）。
  const format = new URL(request.url).searchParams.get("format") === "json" ? "json" : "sse";
  return guarded(request, { url }, format, scopeOf(auth.user));
}
