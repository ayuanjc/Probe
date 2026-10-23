import { translateDocument } from "@/lib/translate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 对照翻译接口。和 /api/search 一样做按 IP 限流：
 * 每条信源点一次「对照原文」就是一个外部请求，不设限等于把本机 IP 借给别人刷。
 * 限额比检索松（20/分钟），因为读报告时连续点开多条是正常行为。
 */
const RL_WINDOW_MS = 60_000;
const RL_MAX = Number(process.env.PROBE_TRANSLATE_RATE_LIMIT_PER_MIN ?? 20);
const hits = new Map<string, number[]>();

function hit(key: string): { ok: boolean; retryAfterMs: number } {
  const now = Date.now();
  const recent = (hits.get(key) ?? []).filter((t) => now - t < RL_WINDOW_MS);
  if (recent.length >= RL_MAX) {
    hits.set(key, recent);
    return { ok: false, retryAfterMs: recent[0] + RL_WINDOW_MS - now };
  }
  recent.push(now);
  hits.set(key, recent);
  return { ok: true, retryAfterMs: 0 };
}

function clientKey(request: Request): string {
  const fwd = request.headers.get("x-forwarded-for");
  return (fwd ? fwd.split(",")[0].trim() : "") || "local";
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

export async function POST(request: Request) {
  const rl = hit(clientKey(request));
  if (!rl.ok) {
    const wait = Math.max(1, Math.ceil(rl.retryAfterMs / 1000));
    return new Response(
      JSON.stringify({ ok: false, error: "rate_limited", message: "对照翻译请求过于频繁，请 " + wait + " 秒后重试。" }),
      { status: 429, headers: { "content-type": "application/json; charset=utf-8", "retry-after": String(wait) } },
    );
  }

  const body = (await request.json().catch(() => null)) as
    | { url?: unknown; title?: unknown; text?: unknown }
    | null;
  if (!body) return json({ ok: false, error: "bad_json", message: "请求体不是合法 JSON。" }, 400);

  const url = typeof body.url === "string" ? body.url.slice(0, 2048) : undefined;
  const title = typeof body.title === "string" ? body.title.slice(0, 400) : undefined;
  const text = typeof body.text === "string" ? body.text.slice(0, 20_000) : undefined;

  if (!url && !title && !text) {
    return json({ ok: false, error: "no_input", message: "需要 url / title / text 至少一项。" }, 400);
  }

  const result = await translateDocument({ url, title, text });
  return json(result, result.ok ? 200 : 422);
}
