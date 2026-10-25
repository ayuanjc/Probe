import { translateDocument } from "@/lib/translate";
import { prepareRuntimeConfig, withRuntimeConfig } from "@/lib/runtime-config";
import { createGate, createLimiter, readPositiveInt } from "@/lib/rate-limit";
import { clientKey, isCrossSite, publicMessage, readJsonBody } from "@/lib/request-guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 对照翻译接口。和 /api/search 一样做按 IP 限流：
 * 每条信源点一次「对照原文」就是一个外部请求，不设限等于把本机 IP 借给别人刷。
 * 限额比检索松（20/分钟），因为读报告时连续点开多条是正常行为。
 */
const perClient = createLimiter({
  name: "translate",
  limit: readPositiveInt("PROBE_TRANSLATE_RATE_LIMIT_PER_MIN", 20),
});

/** 每次对照翻译都要去抓原文/打模型，换 IP 就能绕开 per-IP 额度。 */
const globalLimiter = createLimiter({
  name: "translate-global",
  limit: readPositiveInt("PROBE_GLOBAL_TRANSLATE_PER_MIN", 120),
});

/** 对照翻译是用户主动点开的单条动作，并发给足但必须有上限。 */
const gate = createGate(readPositiveInt("PROBE_TRANSLATE_CONCURRENCY", 4));

/** 20_000 字正文上限（中文约 60KB），留到 96KB。 */
const MAX_BODY_BYTES = 96_000;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

export async function POST(request: Request) {
  if (isCrossSite(request)) return json({ ok: false, error: "cross_site", message: "拒绝跨站调用。" }, 403);

  const per = perClient.check(clientKey(request));
  if (!per.ok) {
    return new Response(
      JSON.stringify({
        ok: false,
        error: "rate_limited",
        message: `对照翻译请求过于频繁，请 ${per.retryAfterSeconds} 秒后重试。`,
      }),
      {
        status: 429,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
          "retry-after": String(per.retryAfterSeconds),
        },
      },
    );
  }
  const all = globalLimiter.check("all");
  if (!all.ok) return json({ ok: false, error: "busy", message: "服务当前请求量过大，请稍后再试。" }, 503);

  const limited = await readJsonBody(request, MAX_BODY_BYTES);
  if (!limited.ok) return json({ ok: false, error: limited.code, message: limited.message }, limited.status);
  const body = limited.value as { url?: unknown; title?: unknown; text?: unknown } | null;
  if (!body || typeof body !== "object") {
    return json({ ok: false, error: "bad_json", message: "请求体不是合法 JSON。" }, 400);
  }

  const url = typeof body.url === "string" ? body.url.slice(0, 2048) : undefined;
  const title = typeof body.title === "string" ? body.title.slice(0, 400) : undefined;
  const text = typeof body.text === "string" ? body.text.slice(0, 20_000) : undefined;

  if (!url && !title && !text) {
    return json({ ok: false, error: "no_input", message: "需要 url / title / text 至少一项。" }, 400);
  }

  const release = gate.acquire();
  if (!release) return json({ ok: false, error: "busy", message: "服务正忙，请稍后再试。" }, 503);

  try {
    // 带上用户自带的 key：有 key 时翻译走模型，没 key 才落到 MyMemory。
    const result = await withRuntimeConfig(await prepareRuntimeConfig(request), () =>
      translateDocument({ url, title, text }),
    );
    return json(result, result.ok ? 200 : 422);
  } catch (err) {
    return json({ ok: false, error: "internal", message: publicMessage(err, "对照翻译失败，请稍后重试。") }, 500);
  } finally {
    release();
  }
}
