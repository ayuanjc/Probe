import { createLimiter, readPositiveInt } from "@/lib/rate-limit";
import { clientKey, isCrossSite, publicMessage, readJsonBody } from "@/lib/request-guard";
import { hashAddress } from "@/lib/auth/crypto";
import { AccountError, accountError, changeOwnPassword } from "@/lib/auth/account";
import { issueSession } from "@/lib/auth/session";
import { requireUser } from "@/lib/auth/guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 改密码。
 *
 * 语义细节（当前密码校验、与旧密码相同要拒、密码规则）在 changeOwnPassword 里。
 * 这里必须记住的一件事：updateUser 改密时会撤销该用户**全部**会话，
 * 所以紧接着要重新签发一枚 cookie，否则用户改完密码就被自己踢出去了。
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
    const updated = await changeOwnPassword({ user: gate.user, current, next, ip });
    const session = await issueSession(updated.id, request, {
      ipHash: hashAddress(ip),
      userAgent: request.headers.get("user-agent") ?? "",
    });
    return json({ ok: true }, 200, { "set-cookie": session.cookie });
  } catch (err) {
    if (err instanceof AccountError) {
      const mapped = accountError(err, "");
      return json({ ok: false, error: mapped.code, message: mapped.message }, mapped.status);
    }
    return json({ ok: false, error: "internal", message: publicMessage(err, "修改密码失败，请稍后重试。") }, 500);
  }
}
