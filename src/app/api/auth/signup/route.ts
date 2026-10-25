import { createLimiter, readPositiveInt } from "@/lib/rate-limit";
import { clientKey, isCrossSite, publicMessage, readJsonBody } from "@/lib/request-guard";
import { hashAddress } from "@/lib/auth/crypto";
import { markLogin, checkInvite } from "@/lib/auth/store";
import { AccountError, accountError, registerWithInvite } from "@/lib/auth/account";
import { issueSession } from "@/lib/auth/session";
import { authMode, ensureBootstrap } from "@/lib/auth/guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 邀请码注册。
 *
 * "先建用户、后记名额"这条顺序、用户名与密码的校验、被撤销/过期/用完的文案，
 * 都在 src/lib/auth/account.ts 的 registerWithInvite 里（那里有测试）。
 * 这里只做：跨站闸、限流、解析、签发会话。
 */
const perClient = createLimiter({
  name: "auth-signup",
  limit: readPositiveInt("PROBE_SIGNUP_RATE_PER_MIN", 3),
});

/**
 * 边输边验那条 GET 单独一组额度：注册页每敲几个字符就发一次，按 POST 的 3/min 会把自己卡死。
 * 但它此前连一条限流都没有 —— 注册页是公开的，任何人可以拿它当「邀请码是否存在 / 是什么角色 /
 * 还剩几个名额」的无限速查询接口。160 位码没法穷举，可一旦码从别处泄露，
 * 这个接口就能把「哪个码还有名额」扫出来，让撞码的人只打活的那几个。
 */
const codeCheck = createLimiter({
  name: "auth-invite-check",
  limit: readPositiveInt("PROBE_INVITE_CHECK_RATE_PER_MIN", 40),
});

const MAX_BODY_BYTES = 4_000;

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
  const code = typeof body?.code === "string" ? body.code.trim() : "";
  const username = typeof body?.username === "string" ? body.username : "";
  const password = typeof body?.password === "string" ? body.password : "";

  if (!code || !username || !password) {
    return json({ ok: false, error: "missing_field", message: "请填写邀请码、用户名和密码。" }, 400);
  }

  try {
    await ensureBootstrap();
    const { user } = await registerWithInvite({ code, username, password, ip });
    const session = await issueSession(user.id, request, {
      ipHash: hashAddress(ip),
      userAgent: request.headers.get("user-agent") ?? "",
    });
    await markLogin(user.id);
    return json(
      { ok: true, user: { username: user.username, role: user.role }, expiresAt: session.expiresAt },
      201,
      { "set-cookie": session.cookie },
    );
  } catch (err) {
    if (err instanceof AccountError) {
      const mapped = accountError(err, "");
      return json({ ok: false, error: mapped.code, message: mapped.message }, mapped.status);
    }
    return json({ ok: false, error: "internal", message: publicMessage(err, "注册失败，请稍后重试。") }, 500);
  }
}

/** 邀请码是否可用（注册页边输边校验用）。不记账，只看。 */
export async function GET(request: Request) {
  if (isCrossSite(request)) return json({ ok: false, error: "cross_site", message: "拒绝跨站调用。" }, 403);
  const per = codeCheck.check(clientKey(request));
  if (!per.ok) {
    return json({ ok: false, error: "rate_limited", message: "校验太频繁，请稍后再试。" }, 429, {
      "retry-after": String(per.retryAfterSeconds),
    });
  }
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
