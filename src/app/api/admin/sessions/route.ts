import { createLimiter, readPositiveInt } from "@/lib/rate-limit";
import { clientKey, isCrossSite, publicMessage } from "@/lib/request-guard";
import {
  AccountError,
  accountError,
  listDevices,
  revokeAllDevices,
  revokeDevice,
} from "@/lib/auth/account";
import { findUserById } from "@/lib/auth/store";
import { requireAdmin } from "@/lib/auth/guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 管理员看/踢某个用户的登录设备。
 *
 * 视图里只有 ipHash（前 16 位指纹）和 UA —— tokenHash 不出现在任何响应里，
 * 它虽不可逆，但无盐 sha256 拿到就能直接比对，等同凭据。
 */
const perClient = createLimiter({
  name: "admin-sessions",
  limit: readPositiveInt("PROBE_ADMIN_RATE_PER_MIN", 60),
});

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function fail(err: unknown, fallback: string): Response {
  const mapped = accountError(err, publicMessage(err, fallback));
  return json({ ok: false, error: mapped.code, message: mapped.message }, mapped.status);
}

function gate(request: Request): Response | null {
  const per = perClient.check(clientKey(request));
  if (!per.ok) {
    return new Response(
      JSON.stringify({ ok: false, error: "rate_limited", message: "操作过于频繁，请稍后再试。" }),
      {
        status: 429,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
          "retry-after": String(per.retryAfterSeconds),
        },
      },
    );
  }
  return null;
}

export async function GET(request: Request) {
  /** 只读接口也拒跨站：这些响应里全是账号与地址指纹，没有一处是给别的站点读的。 */
  if (isCrossSite(request)) return json({ ok: false, error: "cross_site", message: "拒绝跨站调用。" }, 403);
  const auth = await requireAdmin(request);
  if (!auth.ok) return auth.response;
  const limited = gate(request);
  if (limited) return limited;

  const userId = new URL(request.url).searchParams.get("userId") ?? "";
  if (!userId) return json({ ok: false, error: "missing_user", message: "缺少 userId。" }, 400);

  try {
    const user = await findUserById(userId);
    if (!user) return json({ ok: false, error: "not_found", message: "用户不存在。" }, 404);
    const sessions = await listDevices(userId);
    return json({
      ok: true,
      user: { id: user.id, username: user.username },
      sessions,
      liveCount: sessions.filter((s) => s.live).length,
    });
  } catch (err) {
    return fail(err, "读取登录设备失败。");
  }
}

/**
 * 撤销。两种形态：
 *   DELETE ?userId=X&id=S   踢掉这一枚
 *   DELETE ?userId=X&all=1  踢掉这个用户的全部会话
 * 管理员踢自己会连带把当前这枚也作废 —— 前端在「当前会话」那一行不给按钮。
 */
export async function DELETE(request: Request) {
  if (isCrossSite(request)) return json({ ok: false, error: "cross_site", message: "拒绝跨站调用。" }, 403);
  const auth = await requireAdmin(request);
  if (!auth.ok) return auth.response;
  const limited = gate(request);
  if (limited) return limited;

  const params = new URL(request.url).searchParams;
  const userId = params.get("userId") ?? "";
  const id = params.get("id") ?? "";
  const all = params.get("all") === "1";
  if (!userId) return json({ ok: false, error: "missing_user", message: "缺少 userId。" }, 400);
  if (!id && !all) return json({ ok: false, error: "missing_target", message: "缺少 id 或 all=1。" }, 400);

  try {
    if (all) {
      const revoked = await revokeAllDevices({ actor: auth.user.username, ip: clientKey(request), userId });
      return json({ ok: true, revoked });
    }
    await revokeDevice({ actor: auth.user.username, ip: clientKey(request), userId, sessionId: id });
    return json({ ok: true, revoked: 1 });
  } catch (err) {
    if (err instanceof AccountError && err.code === "not_found") {
      return json({ ok: false, error: "not_found", message: err.message }, 404);
    }
    return fail(err, "撤销会话失败。");
  }
}
