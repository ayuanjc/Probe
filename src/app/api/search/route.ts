import { encodeEvent } from "@/lib/sse";
import { runPipeline } from "@/agents/pipeline";
import { configFromRequest, withRuntimeConfig } from "@/lib/runtime-config";
import { createGate, createLimiter, readPositiveInt } from "@/lib/rate-limit";
import { clientKey, isCrossSite, jsonError, publicMessage, rateLimited, readJsonBody } from "@/lib/request-guard";
import { requireUser } from "@/lib/auth/guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * PRD 附录 B：单用户 3 次/分钟。此前完全没有这一层，
 * 一个页面卡住、用户连点几次，就会同时向上游打出十几条查询 ——
 * GDELT 是每 IP 5 秒 1 次的硬限流，这样做只会把自己锁死。
 */
const perClient = createLimiter({
  name: "search",
  limit: readPositiveInt("PROBE_RATE_LIMIT_PER_MIN", 3),
});

/**
 * 全局限流：per-IP 额度挡不住「换 IP 继续打」。
 * 预览站挂在公网 80 端口，脚本换个代理池就是无限次模型调用与外部抓取。
 * 进程级总闸才是那张真正兜底的网。
 */
const globalLimiter = createLimiter({
  name: "search-global",
  limit: readPositiveInt("PROBE_GLOBAL_PER_MIN", 60),
});

/** 并发闸门：同时真的在跑的流水线数量。超了直接 503，不排队。 */
const gate = createGate(readPositiveInt("PROBE_SEARCH_CONCURRENCY", 4));

const MAX_BODY_BYTES = 8_000;

/**
 * 单连接多路 SSE。不能用多个 fetch —— 无法保证事件顺序，
 * 也无法保证模块卡与文本流在时间上对齐（PRD 附录 A）。
 */
function sseResponse(query: string, request: Request, release: () => void): Response {
  const encoder = new TextEncoder();
  const signal = request.signal;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
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
        // key 只活在这段上下文里：不落盘、不写日志、不跨请求共享。
        const cfg = configFromRequest(request);
        await withRuntimeConfig(cfg, async () => {
          for await (const event of runPipeline(query, signal)) {
            // 客户端关掉标签页后继续往下跑没有任何意义：
            // 事件没人收，上游却还在被调用。enqueue 失败就是最可靠的断开信号。
            if (!push(encodeEvent(event))) break;
          }
        });
      } catch (err) {
        // 只回公共文案：上游异常里可能带着内部地址、模型名、响应体片段。
        push(encodeEvent({ event: "error", data: { message: publicMessage(err, "分析过程中出错了，请稍后重试。") } }));
      } finally {
        finish();
      }
    },
    cancel() {
      // 客户端主动断开：让 RunPipeline 在下一个检查点收手，并立刻归还并发槽位。
      release();
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
      "x-content-type-options": "nosniff",
    },
  });
}

async function guarded(request: Request, query: string): Promise<Response> {
  if (isCrossSite(request)) {
    return jsonError(403, "cross_site", "拒绝跨站调用。");
  }

  // 鉴权在限流之前：没登录就不该占用这台机器的检索额度。
  const auth = await requireUser(request);
  if (!auth.ok) return auth.response;

  const per = perClient.check(clientKey(request));
  if (!per.ok) return rateLimited(per.retryAfterSeconds, `请求过于频繁，请 ${per.retryAfterSeconds} 秒后重试。`);

  const all = globalLimiter.check("all");
  if (!all.ok) return rateLimited(all.retryAfterSeconds, `服务当前请求量过大，请 ${all.retryAfterSeconds} 秒后重试。`);

  const trimmed = query.trim();
  if (!trimmed) return jsonError(400, "empty_query", "请提供要分析的查询（?q= 或 {\"query\":\"...\"}）。");
  if (trimmed.length > 400) return jsonError(400, "query_too_long", "查询过长（上限 400 字）。");

  const release = gate.acquire();
  if (!release) {
    return jsonError(503, "busy", "服务正忙，请稍后再试。", { "retry-after": "5" });
  }

  try {
    return sseResponse(trimmed, request, release);
  } catch (err) {
    release();
    return jsonError(500, "internal", publicMessage(err, "分析启动失败，请稍后重试。"));
  }
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  return guarded(request, url.searchParams.get("q") ?? "");
}

export async function POST(request: Request) {
  const body = await readJsonBody(request, MAX_BODY_BYTES);
  if (!body.ok) return jsonError(body.status, body.code, body.message);
  const value = body.value as { query?: unknown };
  const query = typeof value?.query === "string" ? value.query : "";
  return guarded(request, query);
}
