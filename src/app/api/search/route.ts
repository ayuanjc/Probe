import { encodeEvent } from "@/lib/sse";
import { runPipeline } from "@/agents/pipeline";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * PRD 附录 B：单用户 3 次/分钟。此前完全没有这一层，
 * 一个页面卡住、用户连点几次，就会同时向上游打出十几条查询 ——
 * GDELT 是每 IP 5 秒 1 次的硬限流，这样做只会把自己锁死。
 */
const RL_WINDOW_MS = 60_000;
const RL_MAX = Number(process.env.PROBE_RATE_LIMIT_PER_MIN ?? 3);
const rlHits = new Map<string, number[]>();

function hitRateLimit(key: string): { ok: boolean; retryAfterMs: number } {
  const now = Date.now();
  const recent = (rlHits.get(key) ?? []).filter((t) => now - t < RL_WINDOW_MS);
  if (recent.length >= RL_MAX) {
    rlHits.set(key, recent);
    return { ok: false, retryAfterMs: RL_WINDOW_MS - (now - recent[0]) };
  }
  recent.push(now);
  rlHits.set(key, recent);
  return { ok: true, retryAfterMs: 0 };
}

function clientKey(request: Request): string {
  const fwd = request.headers.get("x-forwarded-for");
  return (fwd ? fwd.split(",")[0].trim() : "") || "local";
}

/**
 * 单连接多路 SSE。不能用多个 fetch —— 无法保证事件顺序，
 * 也无法保证模块卡与文本流在时间上对齐（PRD 附录 A）。
 */
function sseResponse(query: string, signal: AbortSignal): Response {
  const encoder = new TextEncoder();

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
        if (closed) return;
        closed = true;
        try {
          controller.close();
        } catch {
          // 已经关闭
        }
      };

      try {
        for await (const event of runPipeline(query, signal)) {
          // 客户端关掉标签页后继续往下跑没有任何意义：
          // 事件没人收，上游却还在被调用。enqueue 失败就是最可靠的断开信号。
          if (!push(encodeEvent(event))) break;
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : "未知错误";
        push(encodeEvent({ event: "error", data: { message } }));
      } finally {
        finish();
      }
    },
    cancel() {
      // 客户端主动断开：让 RunPipeline 在下一个检查点收手。
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

function guarded(request: Request, query: string): Response {
  const rl = hitRateLimit(clientKey(request));
  if (!rl.ok) {
    return new Response(
      JSON.stringify({
        error: "rate_limited",
        message: "请求过于频繁，请 " + Math.ceil(rl.retryAfterMs / 1000) + " 秒后重试。",
      }),
      {
        status: 429,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "retry-after": String(Math.ceil(rl.retryAfterMs / 1000)),
        },
      },
    );
  }
  return sseResponse(query, request.signal);
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  return guarded(request, url.searchParams.get("q") ?? "");
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { query?: string };
  return guarded(request, body.query ?? "");
}
