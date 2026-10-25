import { isCrossSite, publicMessage } from "@/lib/request-guard";
import { listAudit } from "@/lib/auth/store";
import { requireAdmin } from "@/lib/auth/guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 审计日志（倒序，最多 200 条）。只读。 */
export async function GET(request: Request) {
  // 只读接口也拒跨站：这里返回的是账号名、动作与地址指纹。
  if (isCrossSite(request)) {
    return new Response(JSON.stringify({ ok: false, error: "cross_site", message: "拒绝跨站调用。" }), {
      status: 403,
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
    });
  }
  const auth = await requireAdmin(request);
  if (!auth.ok) return auth.response;
  try {
    const limit = Number(new URL(request.url).searchParams.get("limit") ?? "100");
    const entries = await listAudit(Number.isFinite(limit) ? limit : 100);
    return new Response(JSON.stringify({ ok: true, entries }), {
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, message: publicMessage(err, "读取审计日志失败。") }), {
      status: 500,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }
}
