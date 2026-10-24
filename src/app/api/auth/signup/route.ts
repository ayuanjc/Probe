import { createLimiter, readPositiveInt } from "@/lib/rate-limit";
import { clientKey, isCrossSite, publicMessage, readJsonBody } from "@/lib/request-guard";
import { hashAddress, hashPassword, normalizeUsername, passwordProblem } from "@/lib/auth/crypto";
import { audit, checkInvite, commitInviteUse, createUser, findUserByUsername, markLogin } from "@/lib/auth/store";
import { issueSession } from "@/lib/auth/session";
import { authMode, ensureBootstrap } from "@/lib/auth/guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 邀请码注册。
 * 顺序很重要：**先建用户、后记名额**。反过来一旦建号失败（用户名撞了、密码不合规），
 * 邀请码就白吃一次 —— 那是管理员要重新发一个码才能补救的事故。
 */
const perClient = createLimiter({
  name: "auth-signup",
  limit: readPositiveInt("PROBE_SIGNUP_RATE_PER_MIN", 3),
});

const MAX_BODY_BYTES = 4_000;

const INVITE_MESSAGE: Record<string, string> = {
  not_found: "邀请码无效。",
  revoked: "邀请码已被撤销。",
  exhausted: "邀请码已用完。",
  expired: "邀请码已过期。",
};

function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...headers,
    },
  });
}

export async function POST(request: Request) {
  if (isCrossSite(request)) return json({ ok: false, error: "cross_site", message: "拒绝跨站调用。" }, 403);
  if (authMode() === "off") {
    return json({ ok: false, error: "auth_off", message: "当前实例未开启鉴权（PROBE_AUTH_MODE=off）。" }, 409);
  }

  const ip = clientKey(request);
  const per = perClient.check(ip);
  if (!per.ok) {
    return json(
      { ok: false, error: "rate_limited", message: `注册请求过于频繁，请 ${per.retryAfterSeconds} 秒后再试。` },
      429,
      { "retry-after": String(per.retryAfterSeconds) },
    );
  }

  const limited = await readJsonBody(request, MAX_BODY_BYTES);
  if (!limited.ok) return json({ ok: false, error: limited.code, message: limited.message }, limited.status);
  const body = limited.value as { code?: unknown; username?: unknown; password?: unknown } | null;
  const code = typeof body?.code === "string" ? body.code : "";
  const rawName = typeof body?.username === "string" ? body.username : "";
  const password = typeof body?.password === "string" ? body.password : "";

  if (!code || !rawName || !password) {
    return json({ ok: false, error: "missing_field", message: "请填写邀请码、用户名和密码。" }, 400);
  }
  const username = normalizeUsername(rawName);
  if (!username) {
    return json(
      { ok: false, error: "bad_username", message: "用户名只能用 3-32 位小写字母、数字、点、下划线或连字符，且以字母或数字开头。" },
      400,
    );
  }
  const pwProblem = passwordProblem(password, username);
  if (pwProblem) return json({ ok: false, error: "bad_password", message: pwProblem }, 400);

  try {
    await ensureBootstrap();
    const checked = await checkInvite(code);
    if (!checked.ok) {
      await audit({ actor: "signup", action: "invite_rejected", detail: checked.reason, ip });
      return json(
        { ok: false, error: "invite_invalid", message: INVITE_MESSAGE[checked.reason] ?? "邀请码无效。" },
        400,
      );
    }
    if (await findUserByUsername(username)) {
      return json({ ok: false, error: "duplicate_username", message: "这个用户名已被占用。" }, 409);
    }

    const user = await createUser({
      username,
      passwordHash: await hashPassword(password),
      role: checked.invite.role,
      createdBy: `invite:${checked.invite.id}`,
      note: checked.invite.note,
      inviteId: checked.invite.id,
      mustChangePassword: false,
    });
    await commitInviteUse(checked.invite.id, user.id);

    const session = await issueSession(user.id, request, {
      ipHash: hashAddress(ip),
      userAgent: request.headers.get("user-agent") ?? "",
    });
    await markLogin(user.id);
    await audit({
      actor: user.username,
      action: "signup",
      target: user.username,
      detail: `invite=${checked.invite.id.slice(0, 8)}`,
      ip,
    });
    return json(
      { ok: true, user: { username: user.username, role: user.role }, expiresAt: session.expiresAt },
      201,
      { "set-cookie": session.cookie },
    );
  } catch (err) {
    return json({ ok: false, error: "internal", message: publicMessage(err, "注册失败，请稍后重试。") }, 500);
  }
}

/** 邀请码是否可用（注册页边输边校验用）。不记账，只看。 */
export async function GET(request: Request) {
  if (authMode() === "off") return json({ ok: true, valid: false, reason: "auth_off" });
  const code = new URL(request.url).searchParams.get("code") ?? "";
  if (!code) return json({ ok: true, valid: false, reason: "empty" });
  const checked = await checkInvite(code);
  if (!checked.ok) return json({ ok: true, valid: false, reason: checked.reason });
  return json({
    ok: true,
    valid: true,
    role: checked.invite.role,
    remainingUses: Math.max(0, checked.invite.maxUses - checked.invite.uses),
  });
}
