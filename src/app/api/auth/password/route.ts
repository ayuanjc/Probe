import { createLimiter, readPositiveInt } from "@/lib/rate-limit";
import { clientKey, isCrossSite, publicMessage, readJsonBody } from "@/lib/request-guard";
import { hashAddress, hashPassword, passwordProblem, verifyPassword } from "@/lib/auth/crypto";
import { audit, updateUser } from "@/lib/auth/store";
import { issueSession } from "@/lib/auth/session";
import { requireUser } from "@/lib/auth/guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 改密码。改完必须换一枚新 cookie：
 * updateUser 会把该用户的**全部**会话撤销（这是"改密码就该踢掉其他设备"的正确行为），
 * 包括当前这枚 —— 所以紧接着要重新签发，否则用户改完密码就被自己踢出登录。
 */
const perClient = createLimiter({
  name: "auth-password",
  limit: readPositiveInt("PROBE_PASSWORD_RATE_PER_MIN", 5),
});

const MAX_BODY_BYTES = 4_000;

function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
}

export async function POST(request: Request) {
  if (isCrossSite(request)) return json({ ok: false, error: "cross_site", message: "拒绝跨站调用。" }, 403);

  const ip = clientKey(request);
  const per = perClient.check(ip);
  if (!per.ok) {
    return json({ ok: false, error: "rate_limited", message: "操作过于频繁，请稍后再试。" }, 429, {
      "retry-after": String(per.retryAfterSeconds),
    });
  }

  const gate = await requireUser(request);
  if (!gate.ok) return gate.response;

  const limited = await readJsonBody(request, MAX_BODY_BYTES);
  if (!limited.ok) return json({ ok: false, error: limited.code, message: limited.message }, limited.status);
  const body = limited.value as { currentPassword?: unknown; newPassword?: unknown } | null;
  const current = typeof body?.currentPassword === "string" ? body.currentPassword : "";
  const next = typeof body?.newPassword === "string" ? body.newPassword : "";
  if (!current || !next) {
    return json({ ok: false, error: "missing_field", message: "请填写当前密码和新密码。" }, 400);
  }

  try {
    if (!(await verifyPassword(current, gate.user.passwordHash))) {
      await audit({ actor: gate.user.username, action: "password_failed", ip });
      return json({ ok: false, error: "bad_credentials", message: "当前密码不正确。" }, 401);
    }
    const problem = passwordProblem(next, gate.user.username);
    if (problem) return json({ ok: false, error: "bad_password", message: problem }, 400);
    if (await verifyPassword(next, gate.user.passwordHash)) {
      return json({ ok: false, error: "same_password", message: "新密码不能和当前密码相同。" }, 400);
    }

    const updated = await updateUser(gate.user.id, {
      passwordHash: await hashPassword(next),
      mustChangePassword: false,
    });
    const session = await issueSession(updated.id, request, {
      ipHash: hashAddress(ip),
      userAgent: request.headers.get("user-agent") ?? "",
    });
    await audit({ actor: updated.username, action: "password_changed", target: updated.username, ip });
    return json({ ok: true }, 200, { "set-cookie": session.cookie });
  } catch (err) {
    return json({ ok: false, error: "internal", message: publicMessage(err, "修改密码失败，请稍后重试。") }, 500);
  }
}
