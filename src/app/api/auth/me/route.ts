import { resolveSessionFromRequest } from "@/lib/auth/session";
import { authMode } from "@/lib/auth/guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 当前登录态。刻意**不**返回 401 —— 前端拿它决定"显示登录按钮还是用户名"，
 * 401 会被浏览器/框架当成错误刷日志。用 {auth:false} 表达"没登录"。
 */
export async function GET(request: Request) {
  const mode = authMode();
  if (mode === "off") {
    return Response.json(
      { ok: true, auth: false, mode, user: null },
      { headers: { "cache-control": "no-store" } },
    );
  }
  const found = await resolveSessionFromRequest(request);
  if (!found || !found.ok) {
    return Response.json(
      { ok: true, auth: false, mode, user: null },
      { headers: { "cache-control": "no-store" } },
    );
  }
  return Response.json(
    {
      ok: true,
      auth: true,
      mode,
      user: {
        username: found.user.username,
        role: found.user.role,
        mustChangePassword: found.user.mustChangePassword,
        lastLoginAt: found.user.lastLoginAt,
      },
    },
    { headers: { "cache-control": "no-store" } },
  );
}
