import { createLimiter, readPositiveInt } from "@/lib/rate-limit";
import { clientKey, isCrossSite, publicMessage, readJsonBody } from "@/lib/request-guard";
import { hashPassword, newSecretToken, normalizeUsername, passwordProblem } from "@/lib/auth/crypto";
import {
  AuthStoreError,
  audit,
  createUser,
  deleteUser,
  listUsers,
  updateUser,
  type Role,
  type UserStatus,
} from "@/lib/auth/store";
import { requireAdmin } from "@/lib/auth/guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 后台用户管理。全部要求 admin，动手前后各写一条审计。 */
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

function storeError(err: unknown): Response | null {
  if (!(err instanceof AuthStoreError)) return null;
  const map: Record<string, [number, string]> = {
    not_found: [404, "用户不存在。"],
    duplicate_username: [409, "用户名已被占用。"],
    last_admin: [409, "这是最后一个可用的管理员，这个操作会把自己锁在门外。"],
    store_corrupt: [503, "授权数据文件损坏，请检查服务端日志。"],
  };
  const hit = map[err.code];
  return hit ? json({ ok: false, error: err.code, message: hit[1] }, hit[0]) : null;
}

function gate(request: Request): Response | null {
  const per = perClient.check(clientKey(request));
  if (!per.ok) return json({ ok: false, error: "rate_limited", message: "操作过于频繁，请稍后再试。" }, 429);
  return null;
}

export async function GET(request: Request) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return auth.response;
  const limited = gate(request);
  if (limited) return limited;
  try {
    return json({ ok: true, users: await listUsers() });
  } catch (err) {
    return json({ ok: false, error: "internal", message: publicMessage(err, "读取用户列表失败。") }, 500);
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

  const username = normalizeUsername(typeof body?.username === "string" ? body.username : "");
  if (!username) {
    return json({ ok: false, error: "bad_username", message: "用户名只能用 3-32 位小写字母、数字、点、下划线或连字符。" }, 400);
  }
  const role: Role = body?.role === "admin" ? "admin" : "member";
  const note = typeof body?.note === "string" ? body.note.slice(0, 200) : "";

  // 没填密码就生成一个 —— 后台"添加测试用户"最常见的用法，别逼管理员现编。
  const given = typeof body?.password === "string" ? body.password : "";
  const generated = given ? null : newSecretToken(12);
  const password = given || generated || "";
  const problem = passwordProblem(password, username);
  if (problem) {
    return json({ ok: false, error: "bad_password", message: generated ? `生成的密码不合规：${problem}` : problem }, 400);
  }

  try {
    const user = await createUser({
      username,
      passwordHash: await hashPassword(password),
      role,
      createdBy: auth.user.username,
      note,
      mustChangePassword: true,
    });
    await audit({
      actor: auth.user.username,
      action: "user_created",
      target: user.username,
      detail: `role=${user.role}`,
      ip: clientKey(request),
    });
    const { passwordHash: _drop, ...safe } = user;
    void _drop;
    // 明文密码只在这一次响应里出现，之后库里只剩 scrypt 哈希。
    return json({ ok: true, user: safe, password: generated ? password : undefined }, 201);
  } catch (err) {
    return storeError(err) ?? json({ ok: false, error: "internal", message: publicMessage(err, "创建用户失败。") }, 500);
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
    | { id?: unknown; role?: unknown; status?: unknown; note?: unknown; newPassword?: unknown }
    | null;
  const id = typeof body?.id === "string" ? body.id : "";
  if (!id) return json({ ok: false, error: "missing_id", message: "缺少用户 id。" }, 400);

  const patch: {
    role?: Role;
    status?: UserStatus;
    note?: string;
    passwordHash?: string;
    mustChangePassword?: boolean;
  } = {};
  if (body?.role === "admin" || body?.role === "member") patch.role = body.role;
  if (body?.status === "active" || body?.status === "disabled") patch.status = body.status;
  if (typeof body?.note === "string") patch.note = body.note;

  const newPassword = typeof body?.newPassword === "string" ? body.newPassword : "";
  if (newPassword) {
    const problem = passwordProblem(newPassword);
    if (problem) return json({ ok: false, error: "bad_password", message: problem }, 400);
    patch.passwordHash = await hashPassword(newPassword);
    // 管理员重置的密码要求本人登录后改掉。
    patch.mustChangePassword = true;
  }
  if (Object.keys(patch).length === 0) {
    return json({ ok: false, error: "nothing_to_change", message: "没有需要修改的字段。" }, 400);
  }

  try {
    const user = await updateUser(id, patch);
    await audit({
      actor: auth.user.username,
      action: "user_updated",
      target: user.username,
      detail: Object.keys(patch).join(","),
      ip: clientKey(request),
    });
    const { passwordHash: _drop, ...safe } = user;
    void _drop;
    return json({ ok: true, user: safe });
  } catch (err) {
    return storeError(err) ?? json({ ok: false, error: "internal", message: publicMessage(err, "更新用户失败。") }, 500);
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
  if (id === auth.user.id) {
    return json({ ok: false, error: "self_delete", message: "不能删除当前登录的自己。" }, 400);
  }
  try {
    await deleteUser(id);
    await audit({ actor: auth.user.username, action: "user_deleted", target: id, ip: clientKey(request) });
    return json({ ok: true });
  } catch (err) {
    return storeError(err) ?? json({ ok: false, error: "internal", message: publicMessage(err, "删除用户失败。") }, 500);
  }
}
