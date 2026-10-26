import { createLimiter, readPositiveInt } from "@/lib/rate-limit";
import { isCrossSite, jsonError, publicMessage, rateLimited, readJsonBody } from "@/lib/request-guard";
import { requireUser } from "@/lib/auth/guard";
import { prepareRuntimeConfig, regionSummary, withRuntimeConfig } from "@/lib/runtime-config";
import { historyEnabled, importQueries } from "@/lib/history-store";
import { recordOp } from "@/lib/ops-counters";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 浏览器里的旧历史（localStorage）一次性导入。
 *
 * 为什么要有这一步：一刀切会让用户「上个月问的那些」凭空消失。
 * 对一个以「不撒谎」为卖点的产品，「你的历史不见了」比「历史多存了一份」严重得多。
 *
 * 服务端重算 region：客户端能编造一个「境外」出来，让历史看起来像是在别的区域跑的。
 * 幂等：同一条 query 在 ±1 分钟窗口内已存在就跳过，所以重复调用不会灌出重复记录。
 */
const perClient = createLimiter({
  name: "history-import",
  limit: readPositiveInt("PROBE_HISTORY_IMPORT_PER_MIN", 2),
});

const MAX_BODY_BYTES = 64_000;

export async function POST(request: Request) {
  if (isCrossSite(request)) return jsonError(403, "cross_site", "拒绝跨站调用。");

  const auth = await requireUser(request);
  if (!auth.ok) return auth.response;

  const per = perClient.check(auth.user.id);
  if (!per.ok) return rateLimited(per.retryAfterSeconds, "导入太频繁，请稍后再试。");

  if (!historyEnabled()) return jsonError(404, "history_disabled", "这件功能没有开启。");

  const body = await readJsonBody(request, MAX_BODY_BYTES);
  if (!body.ok) return jsonError(body.status, body.code, body.message);

  const value = body.value as { items?: unknown };
  const items = Array.isArray(value?.items) ? value.items : null;
  if (!items) return jsonError(422, "invalid_body", "要这样传：{ items: [{ query, at? }] }");

  const cleaned: { query: string; at?: number }[] = [];
  for (const item of items.slice(0, 200)) {
    const row = item as { query?: unknown; at?: unknown };
    if (!row || typeof row.query !== "string") continue;
    cleaned.push({ query: row.query, at: typeof row.at === "number" ? row.at : undefined });
  }
  if (cleaned.length === 0) return Response.json({ ok: true, imported: 0, skipped: 0 });

  try {
    const cfg = await prepareRuntimeConfig(request);
    const summary = withRuntimeConfig(cfg, () => regionSummary());
    const result = importQueries(auth.user.id, cleaned, { region: summary.region, modelHost: summary.modelHost });
    recordOp("import");
    return Response.json({ ok: true, ...result }, { headers: { "cache-control": "no-store" } });
  } catch (err) {
    return jsonError(500, "history_import_failed", publicMessage(err, "导入历史失败，请稍后重试。"));
  }
}
