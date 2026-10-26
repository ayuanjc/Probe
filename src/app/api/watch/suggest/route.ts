import { createLimiter, readPositiveInt } from "@/lib/rate-limit";
import { isCrossSite, jsonError, publicMessage, rateLimited } from "@/lib/request-guard";
import { requireUser } from "@/lib/auth/guard";
import { suggestWatches, watchEnabled } from "@/lib/watch-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 建议关注：从自己最近 200 条历史里数实体出现次数。只建议，不自动关注。 */
const read = createLimiter({
  name: "watch-suggest",
  limit: readPositiveInt("PROBE_WATCH_RATE_PER_MIN", 60),
});

export async function GET(request: Request) {
  if (isCrossSite(request)) return jsonError(403, "cross_site", "拒绝跨站调用。");
  const auth = await requireUser(request);
  if (!auth.ok) return auth.response;

  const per = read.check(auth.user.id);
  if (!per.ok) return rateLimited(per.retryAfterSeconds, "读取太频繁，请稍后再试。");
  if (!watchEnabled()) {
    return Response.json({ ok: true, enabled: false, items: [] }, { headers: { "cache-control": "no-store" } });
  }

  try {
    return Response.json(
      { ok: true, enabled: true, items: suggestWatches(auth.user.id, 5) },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (err) {
    return jsonError(500, "watch_suggest_failed", publicMessage(err, "生成建议失败，请稍后重试。"));
  }
}
