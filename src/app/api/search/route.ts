import { encodeEvent } from "@/lib/sse";
import { runPipeline } from "@/agents/pipeline";
import { configFromRequest, withRuntimeConfig } from "@/lib/runtime-config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * PRD 附录 B：单用户 3 次/分钟。此前完全没有这一层，
 * 一个页面卡住、用户连点几次，就会同时向上游打出十几条查询 ——
 * GDELT 是每 IP 5 秒 1 次的硬限流，这样做只会把自己锁死。
 */
const RL_WINDOW_MS = 60_000;

/**
 * 环境变量读坏了要当「没设」，不能当 0、更不能当 NaN：
 * Number("abc") 是 NaN，而 recent.length >= NaN 恒为 false ——
 * 也就是说一个笔误的环境变量会**静默把限流关掉**，日志里一个字都没有。
 */
function readLimit(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    console.warn("[rate-limit] " + name + "=" + raw + " 不是正数，按默认 " + fallback + " 处理");
    return fallback;
  }
  return Math.floor(n);
}

const RL_MAX = readLimit("PROBE_RATE_LIMIT_PER_MIN", 3);
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

  /**
   * 表要自己收：旧实现只在同一个 key 再次命中时才裁自己那条，
   * 于是每个不同 IP 都留一条永不删除的记录。预览站挂在公网 80 端口上，
   * 被扫一轮就是一个只增不减的 Map（进程活多久它长多久）。
   */
  if (rlHits.size > 512) {
    for (const [k, list] of rlHits) {
      if (list.every((t) => now - t >= RL_WINDOW_MS)) rlHits.delete(k);
    }
  }
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
  // key 只活在这里：ReadableStream 的 start 是同步调起的，
  // 之后的 await 延续仍然带着这份 AsyncLocalStorage 上下文。
  // 不落盘、不写日志、不跨请求共享。
  const cfg = configFromRequest(request);
  return withRuntimeConfig(cfg, () => sseResponse(query, request.signal));
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  return guarded(request, url.searchParams.get("q") ?? "");
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { query?: string };
  return guarded(request, body.query ?? "");
}
