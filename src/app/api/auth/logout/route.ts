import { isCrossSite } from "@/lib/request-guard";
import { audit } from "@/lib/auth/store";
import { clearCookie, destroySession, readSessionCookie } from "@/lib/auth/session";
import { requireUser } from "@/lib/auth/guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 退出登录：撤销服务端会话 + 清 cookie。撤销必须在服务端做，光清 cookie 等于没退。 */
export async function POST(request: Request) {
  if (isCrossSite(request)) {
    return new Response(JSON.stringify({ ok: false, error: "cross_site" }), {
      status: 403,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }
  // 先拿身份再撤销，否则日志里只剩一个匿名动作。
  const gate = await requireUser(request);
  const actor = gate.ok ? gate.user.username : "anonymous";
  const had = Boolean(readSessionCookie(request));
  await destroySession(request);
  if (had) await audit({ actor, action: "logout" });
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "set-cookie": clearCookie(request),
    },
  });
}
