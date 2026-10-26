import { createLimiter, readPositiveInt } from "@/lib/rate-limit";
import { isCrossSite, jsonError, publicMessage, rateLimited, readJsonBody } from "@/lib/request-guard";
import { requireUser } from "@/lib/auth/guard";
import { countUnread, markAllRead, markRead, watchEnabled } from "@/lib/watch-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 标记已读。两种用法：
 *   {"ids":["…","…"]}        —— 点开某几条（≤200）
 *   {"all":true,"watch":"…"} —— 整个关注清空未读（watch 省略 = 全部）
 *
 * 幂等：已读的再标一次不会报错，也不会改时间。别人的 id 静默跳过。
 */
const write = createLimiter({
  name: "watch-read-mark",
  limit: readPositiveInt("PROBE_WATCH_WRITE_PER_MIN", 10),
});

const MAX_BODY_BYTES = 8_000;

export async function POST(request: Request) {
  if (isCrossSite(request)) return jsonError(403, "cross_site", "拒绝跨站调用。");
  const auth = await requireUser(request);
  if (!auth.ok) return auth.response;

  const per = write.check(auth.user.id);
  if (!per.ok) return rateLimited(per.retryAfterSeconds, "操作太频繁，请稍后再试。");
  if (!watchEnabled()) return jsonError(404, "watch_disabled", "这件功能没有开启。");

  const body = await readJsonBody(request, MAX_BODY_BYTES);
  const value = body.ok ? (body.value as { ids?: unknown; all?: unknown; watch?: unknown }) : null;
  if (!value) return jsonError(400, "bad_body", "请求体格式不对。");

  try {
    let changed = 0;
    if (value.all === true) {
      const watchId = typeof value.watch === "string" && value.watch ? value.watch : null;
      changed = markAllRead(auth.user.id, watchId);
    } else {
      const ids = Array.isArray(value.ids)
        ? value.ids.filter((x): x is string => typeof x === "string" && x.length > 0).slice(0, 200)
        : [];
      if (ids.length === 0) return jsonError(400, "bad_ids", "要带 ids 数组，或 all:true。");
      changed = markRead(auth.user.id, ids);
    }
    return Response.json(
      { ok: true, changed, unread: countUnread(auth.user.id) },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (err) {
    return jsonError(500, "watch_read_mark_failed", publicMessage(err, "标记已读失败，请稍后重试。"));
  }
}
