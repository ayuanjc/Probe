
import { encodeEvent } from "@/lib/sse";
import { runPipeline } from "@/agents/pipeline";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 单连接多路 SSE。不能用多个 fetch —— 无法保证事件顺序，
 * 也无法保证模块卡与文本流在时间上对齐（PRD 附录 A）。
 */
function sseResponse(query: string): Response {
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const event of runPipeline(query)) {
          controller.enqueue(encoder.encode(encodeEvent(event)));
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : "未知错误";
        controller.enqueue(
          encoder.encode(encodeEvent({ event: "error", data: { message } })),
        );
      } finally {
        controller.close();
      }
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

export async function GET(request: Request) {
  const url = new URL(request.url);
  return sseResponse(url.searchParams.get("q") ?? "");
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { query?: string };
  return sseResponse(body.query ?? "");
}
