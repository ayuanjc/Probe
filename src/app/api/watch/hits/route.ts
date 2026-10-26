import { createLimiter, readPositiveInt } from "@/lib/rate-limit";
import { isCrossSite, jsonError, publicMessage, rateLimited } from "@/lib/request-guard";
import { requireUser } from "@/lib/auth/guard";
import { countUnread, listHits, watchEnabled } from "@/lib/watch-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 命中列表：?watch=<id>&limit=&before=&unread=1 */
const read = createLimiter({
  name: "watch-hits",
  limit: readPositiveInt("PROBE_WATCH_RATE_PER_MIN", 60),
});

export async function GET(request: Request) {
  if (isCrossSite(request)) return jsonError(403, "cross_site", "拒绝跨站调用。");
  const auth = await requireUser(request);
  if (!auth.ok) return auth.response;

  const per = read.check(auth.user.id);
  if (!per.ok) return rateLimited(per.retryAfterSeconds, "读取太频繁，请稍后再试。");

  if (!watchEnabled()) {
    return Response.json(
      { ok: true, enabled: false, items: [], next: null, unread: 0 },
      { headers: { "cache-control": "no-store" } },
    );
  }

  const url = new URL(request.url);
  const watch = url.searchParams.get("watch");
  const before = Number(url.searchParams.get("before"));
  const limit = Number(url.searchParams.get("limit"));
  const unreadOnly = url.searchParams.get("unread") === "1";

  try {
    const page = listHits(auth.user.id, {
      watchId: watch || null,
      limit: Number.isFinite(limit) ? limit : undefined,
      before: Number.isFinite(before) && before > 0 ? before : null,
      unreadOnly,
    });
    return Response.json(
      { ok: true, enabled: true, items: page.items, next: page.next, unread: countUnread(auth.user.id) },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (err) {
    return jsonError(500, "watch_hits_failed", publicMessage(err, "读取命中失败，请稍后重试。"));
  }
}
