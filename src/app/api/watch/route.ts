import { createLimiter, readPositiveInt } from "@/lib/rate-limit";
import { isCrossSite, jsonError, publicMessage, rateLimited, readJsonBody } from "@/lib/request-guard";
import { requireUser } from "@/lib/auth/guard";
import { addWatch, clearWatches, countUnread, listWatches, removeWatch, watchEnabled } from "@/lib/watch-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 我的关注：增 / 列 / 删。
 *
 * 三条口径：
 *   1. 功能关掉时返回 `enabled:false` + 空列表，界面据此隐藏，而不是报错（与 /api/history 一致）。
 *   2. 别人的关注一律当成不存在：删除返回 `{ok:true, removed:false}`，不是 403 —— 403 等于确认它存在。
 *   3. 清空要带 {"confirm":"DELETE"}，和删历史同一个规矩。
 */
const read = createLimiter({
  name: "watch-read",
  limit: readPositiveInt("PROBE_WATCH_RATE_PER_MIN", 60),
});

const write = createLimiter({
  name: "watch-write",
  limit: readPositiveInt("PROBE_WATCH_WRITE_PER_MIN", 10),
});

const MAX_BODY_BYTES = 2_000;

function disabled(): Response {
  return Response.json(
    { ok: true, enabled: false, items: [], unread: 0 },
    { headers: { "cache-control": "no-store" } },
  );
}

export async function GET(request: Request) {
  if (isCrossSite(request)) return jsonError(403, "cross_site", "拒绝跨站调用。");
  const auth = await requireUser(request);
  if (!auth.ok) return auth.response;

  const per = read.check(auth.user.id);
  if (!per.ok) return rateLimited(per.retryAfterSeconds, "读取太频繁，请稍后再试。");
  if (!watchEnabled()) return disabled();

  try {
    const items = listWatches(auth.user.id);
    return Response.json(
      { ok: true, enabled: true, items, unread: countUnread(auth.user.id) },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (err) {
    return jsonError(500, "watch_read_failed", publicMessage(err, "读取关注失败，请稍后重试。"));
  }
}

export async function POST(request: Request) {
  if (isCrossSite(request)) return jsonError(403, "cross_site", "拒绝跨站调用。");
  const auth = await requireUser(request);
  if (!auth.ok) return auth.response;

  const per = write.check(auth.user.id);
  if (!per.ok) return rateLimited(per.retryAfterSeconds, "操作太频繁，请稍后再试。");
  if (!watchEnabled()) return jsonError(404, "watch_disabled", "这件功能没有开启。");

  const body = await readJsonBody(request, MAX_BODY_BYTES);
  const value = body.ok ? (body.value as { name?: unknown; kind?: unknown }) : null;
  if (!value) return jsonError(400, "bad_body", "请求体格式不对。");

  const name = typeof value.name === "string" ? value.name.trim().slice(0, 80) : "";
  if (name.length < 2) return jsonError(400, "bad_name", "关注名至少 2 个字。");

  try {
    const result = addWatch(auth.user.id, { name, kind: typeof value.kind === "string" ? value.kind : undefined });
    return Response.json(
      { ok: true, item: result.watch, created: result.created, unread: countUnread(auth.user.id) },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : "";
    if (msg === "watch_bad_name") return jsonError(400, "bad_name", "关注名太短，或全是符号。");
    if (msg === "watch_cap") return jsonError(400, "watch_cap", "关注数量到上限了，删几个再加。");
    return jsonError(500, "watch_add_failed", publicMessage(err, "添加关注失败，请稍后重试。"));
  }
}

export async function DELETE(request: Request) {
  if (isCrossSite(request)) return jsonError(403, "cross_site", "拒绝跨站调用。");
  const auth = await requireUser(request);
  if (!auth.ok) return auth.response;

  const per = write.check(auth.user.id);
  if (!per.ok) return rateLimited(per.retryAfterSeconds, "操作太频繁，请稍后再试。");
  if (!watchEnabled()) return jsonError(404, "watch_disabled", "这件功能没有开启。");

  const url = new URL(request.url);
  const id = url.searchParams.get("id");

  try {
    if (id) {
      const removed = removeWatch(auth.user.id, id);
      // 不存在 / 不属于自己，都回同一个「删完了」—— 幂等且不泄露存在性。
      return Response.json({ ok: true, removed }, { headers: { "cache-control": "no-store" } });
    }

    const body = await readJsonBody(request, MAX_BODY_BYTES);
    const value = body.ok ? (body.value as { confirm?: unknown }) : null;
    if (!value || value.confirm !== "DELETE") {
      return jsonError(400, "confirm_required", "清空关注要带 {\"confirm\":\"DELETE\"}；只删一条请用 ?id=。");
    }
    return Response.json(
      { ok: true, removed: clearWatches(auth.user.id) },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (err) {
    return jsonError(500, "watch_delete_failed", publicMessage(err, "删除关注失败，请稍后重试。"));
  }
}
