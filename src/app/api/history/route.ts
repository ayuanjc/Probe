import { createLimiter, readPositiveInt } from "@/lib/rate-limit";
import { isCrossSite, jsonError, publicMessage, rateLimited, readJsonBody } from "@/lib/request-guard";
import { requireUser } from "@/lib/auth/guard";
import {
  clearQueries,
  countQueries,
  deleteQuery,
  getQuery,
  historyEnabled,
  listQueries,
} from "@/lib/history-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 账号级历史（P0）。
 *
 * 用扁平路径 + 查询参数而不是 /api/history/[id]：
 * 这个仓库现在一条带动态段的 API 路由都没有，为一个 CRUD 引入新的路由约定不值得。
 *
 * 三条口径：
 *   1. 别人的历史一律 404（不是 403）—— 403 等于告诉对方「这条存在」。
 *   2. 功能关掉时返回空列表 + `enabled:false`，界面据此隐藏，而不是报错。
 *   3. 删除是物理删除（连带 query_sources 级联），因为隐私政策里承诺了「删除即消失」。
 */
const perClient = createLimiter({
  name: "history",
  limit: readPositiveInt("PROBE_HISTORY_RATE_PER_MIN", 60),
});

const WRITE_LIMIT = createLimiter({
  name: "history-write",
  limit: readPositiveInt("PROBE_HISTORY_WRITE_PER_MIN", 10),
});

const MAX_BODY_BYTES = 4_000;

function disabled(): Response {
  return Response.json(
    { ok: true, enabled: false, items: [], next: null, total: 0 },
    { headers: { "cache-control": "no-store" } },
  );
}

export async function GET(request: Request) {
  if (isCrossSite(request)) return jsonError(403, "cross_site", "拒绝跨站调用。");

  const auth = await requireUser(request);
  if (!auth.ok) return auth.response;

  const per = perClient.check(auth.user.id);
  if (!per.ok) return rateLimited(per.retryAfterSeconds, "读取太频繁，请稍后再试。");

  if (!historyEnabled()) return disabled();

  const url = new URL(request.url);
  const id = url.searchParams.get("id");

  try {
    if (id) {
      const row = getQuery(auth.user.id, id);
      // 别人的、已过期的、不存在的，回同一个 404。
      if (!row) return jsonError(404, "not_found", "没有这条记录（可能已过期，或不属于当前账号）。");
      return Response.json({ ok: true, item: row }, { headers: { "cache-control": "no-store" } });
    }

    const before = Number(url.searchParams.get("before"));
    const limit = Number(url.searchParams.get("limit"));
    const page = listQueries(auth.user.id, {
      limit: Number.isFinite(limit) ? limit : undefined,
      before: Number.isFinite(before) && before > 0 ? before : null,
      q: url.searchParams.get("q"),
    });

    return Response.json(
      { ok: true, enabled: true, items: page.items, next: page.next, total: countQueries(auth.user.id) },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (err) {
    return jsonError(500, "history_read_failed", publicMessage(err, "读取历史失败，请稍后重试。"));
  }
}

export async function DELETE(request: Request) {
  if (isCrossSite(request)) return jsonError(403, "cross_site", "拒绝跨站调用。");

  const auth = await requireUser(request);
  if (!auth.ok) return auth.response;

  const per = WRITE_LIMIT.check(auth.user.id);
  if (!per.ok) return rateLimited(per.retryAfterSeconds, "删除太频繁，请稍后再试。");

  if (!historyEnabled()) return jsonError(404, "history_disabled", "这件功能没有开启。");

  const url = new URL(request.url);
  const id = url.searchParams.get("id");

  try {
    if (id) {
      deleteQuery(auth.user.id, id);
      // 幂等：本来就没有也算删成功 —— 用户要的是「它不在了」。
      return Response.json({ ok: true }, { headers: { "cache-control": "no-store" } });
    }

    // 清空要带确认词，防止一个误触的 DELETE 把整本历史抹掉。
    const body = await readJsonBody(request, MAX_BODY_BYTES);
    const value = body.ok ? (body.value as { confirm?: unknown }) : null;
    if (!value || value.confirm !== "DELETE") {
      return jsonError(400, "confirm_required", '清空历史要带 {"confirm":"DELETE"}；只删一条请用 ?id=。');
    }
    const removed = clearQueries(auth.user.id);
    return Response.json({ ok: true, removed }, { headers: { "cache-control": "no-store" } });
  } catch (err) {
    return jsonError(500, "history_delete_failed", publicMessage(err, "删除历史失败，请稍后重试。"));
  }
}
