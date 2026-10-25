import { createLimiter, readPositiveInt } from "@/lib/rate-limit";
import { isCrossSite, jsonError, publicMessage, rateLimited } from "@/lib/request-guard";
import { requireUser } from "@/lib/auth/guard";
import { historyEnabled, listQueries } from "@/lib/history-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 导出自己的全部历史（JSON）。
 *
 * 这是「用户有权拿到自己的数据」那个权利的落点（个人信息保护法第 45 条可携带）。
 * 分页在服务端做完再一次返回：上限 500 条（= 每人上限），再多也没有。
 */
const perClient = createLimiter({
  name: "history-export",
  limit: readPositiveInt("PROBE_HISTORY_EXPORT_PER_MIN", 2),
});

export async function GET(request: Request) {
  if (isCrossSite(request)) return jsonError(403, "cross_site", "拒绝跨站调用。");

  const auth = await requireUser(request);
  if (!auth.ok) return auth.response;

  const per = perClient.check(auth.user.id);
  if (!per.ok) return rateLimited(per.retryAfterSeconds, "导出太频繁，请稍后再试。");

  if (!historyEnabled()) return jsonError(404, "history_disabled", "这件功能没有开启。");

  try {
    const all = [];
    let before: number | null = null;
    for (let page = 0; page < 20; page += 1) {
      const chunk = listQueries(auth.user.id, { limit: 50, before });
      all.push(...chunk.items);
      if (!chunk.next) break;
      before = chunk.next;
    }
    return new Response(JSON.stringify({ ok: true, exportedAt: Date.now(), items: all }, null, 2), {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "content-disposition": 'attachment; filename="probe-history.json"',
        // 导出的是个人信息：任何中间层都不许缓存。
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    });
  } catch (err) {
    return jsonError(500, "history_export_failed", publicMessage(err, "导出历史失败，请稍后重试。"));
  }
}
