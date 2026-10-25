import { createLimiter, readPositiveInt } from "@/lib/rate-limit";
import { clientKey, isCrossSite, publicMessage, readJsonBody } from "@/lib/request-guard";
import {
  AccountError,
  accountError,
  createAccount,
  deleteAccount,
  listAccounts,
  updateAccount,
} from "@/lib/auth/account";
import type { Role, UserStatus } from "@/lib/auth/store";
import { requireAdmin } from "@/lib/auth/guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 后台用户管理。全部要求 admin。
 *
 * 这层只做四件事：鉴权、限流、解析 JSON、把 AccountError 翻成 HTTP。
 * 业务规则（用户名/密码校验、随机初始密码、强制改密、last_admin 保护、审计）
 * 全在 src/lib/auth/account.ts —— 那里才有测试，路由里不要再写第二份。
 */
const perClient = createLimiter({
  name: "admin-users",
  limit: readPositiveInt("PROBE_ADMIN_RATE_PER_MIN", 60),
});

const MAX_BODY_BYTES = 8_000;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

/** 统一的失败出口：code + message + 状态码都从 account.ts 来。 */
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
  try {
    const users = await listAccounts();
    return json({ ok: true, users });
  } catch (err) {
    return fail(err, "读取用户列表失败。");
  }
}

export async function POST(request: Request) {
  if (isCrossSite(request)) return json({ ok: false, error: "cross_site", message: "拒绝跨站调用。" }, 403);
  const auth = await requireAdmin(request);
  if (!auth.ok) return auth.response;
  const limited = gate(request);
  if (limited) return limited;

  const parsed = await readJsonBody(request, MAX_BODY_BYTES);
  if (!parsed.ok) return json({ ok: false, error: parsed.code, message: parsed.message }, parsed.status);
  const body = parsed.value as
    | { username?: unknown; role?: unknown; password?: unknown; note?: unknown }
    | null;

  try {
    const { user, generatedPassword } = await createAccount({
      actor: auth.user.username,
      ip: clientKey(request),
      username: typeof body?.username === "string" ? body.username : "",
      role: body?.role === "admin" ? "admin" : "member",
      note: typeof body?.note === "string" ? body.note : "",
      password: typeof body?.password === "string" ? body.password : undefined,
    });
    // 明文密码只在这一次响应里出现，之后库里只剩 scrypt 哈希。
    return json({ ok: true, user, password: generatedPassword }, 201);
  } catch (err) {
    return fail(err, "创建用户失败。");
  }
}

export async function PATCH(request: Request) {
  if (isCrossSite(request)) return json({ ok: false, error: "cross_site", message: "拒绝跨站调用。" }, 403);
  const auth = await requireAdmin(request);
  if (!auth.ok) return auth.response;
  const limited = gate(request);
  if (limited) return limited;

  const parsed = await readJsonBody(request, MAX_BODY_BYTES);
  if (!parsed.ok) return json({ ok: false, error: parsed.code, message: parsed.message }, parsed.status);
  const body = parsed.value as
    | {
        id?: unknown;
        role?: unknown;
        status?: unknown;
        note?: unknown;
        newPassword?: unknown;
        mustChangePassword?: unknown;
      }
    | null;
  const id = typeof body?.id === "string" ? body.id : "";
  if (!id) return json({ ok: false, error: "missing_id", message: "缺少用户 id。" }, 400);

  try {
    const { user, changed } = await updateAccount({
      actor: auth.user.username,
      ip: clientKey(request),
      id,
      role: body?.role === "admin" || body?.role === "member" ? (body.role as Role) : undefined,
      status:
        body?.status === "active" || body?.status === "disabled" ? (body.status as UserStatus) : undefined,
      note: typeof body?.note === "string" ? body.note : undefined,
      newPassword: typeof body?.newPassword === "string" ? body.newPassword : undefined,
      mustChangePassword:
        typeof body?.mustChangePassword === "boolean" ? body.mustChangePassword : undefined,
    });
    return json({ ok: true, user, changed });
  } catch (err) {
    if (err instanceof AccountError && err.code === "not_found") {
      return json({ ok: false, error: "not_found", message: "用户不存在。" }, 404);
    }
    return fail(err, "更新用户失败。");
  }
}

export async function DELETE(request: Request) {
  if (isCrossSite(request)) return json({ ok: false, error: "cross_site", message: "拒绝跨站调用。" }, 403);
  const auth = await requireAdmin(request);
  if (!auth.ok) return auth.response;
  const limited = gate(request);
  if (limited) return limited;

  const id = new URL(request.url).searchParams.get("id") ?? "";
  if (!id) return json({ ok: false, error: "missing_id", message: "缺少用户 id。" }, 400);

  try {
    await deleteAccount({ actor: auth.user.username, ip: clientKey(request), selfId: auth.user.id, id });
    return json({ ok: true });
  } catch (err) {
    return fail(err, "删除用户失败。");
  }
}
