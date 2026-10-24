import { createLimiter, readPositiveInt } from "@/lib/rate-limit";
import { clientKey, isCrossSite, publicMessage, readJsonBody } from "@/lib/request-guard";
import {
  AuthStoreError,
  audit,
  createInvite,
  listInvites,
  revokeInvite,
  type Role,
} from "@/lib/auth/store";
import { requireAdmin } from "@/lib/auth/guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 后台邀请码管理。明文码只在创建响应里出现一次。 */
const perClient = createLimiter({
  name: "admin-invites",
  limit: readPositiveInt("PROBE_ADMIN_RATE_PER_MIN", 60),
});

const MAX_BODY_BYTES = 4_000;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

export async function GET(request: Request) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return auth.response;
  try {
    return json({ ok: true, invites: await listInvites() });
  } catch (err) {
    return json({ ok: false, error: "internal", message: publicMessage(err, "读取邀请码失败。") }, 500);
  }
}

export async function POST(request: Request) {
  if (isCrossSite(request)) return json({ ok: false, error: "cross_site", message: "拒绝跨站调用。" }, 403);
  const auth = await requireAdmin(request);
  if (!auth.ok) return auth.response;
  const per = perClient.check(clientKey(request));
  if (!per.ok) return json({ ok: false, error: "rate_limited", message: "操作过于频繁，请稍后再试。" }, 429);

  const parsed = await readJsonBody(request, MAX_BODY_BYTES);
  if (!parsed.ok) return json({ ok: false, error: parsed.code, message: parsed.message }, parsed.status);
  const body = parsed.value as
    | { note?: unknown; role?: unknown; maxUses?: unknown; expiresInHours?: unknown }
    | null;

  const role: Role = body?.role === "admin" ? "admin" : "member";
  const note = typeof body?.note === "string" ? body.note : "";
  const maxUses = Number(body?.maxUses ?? 1);
  // null / 0 / 负数 都表示"永不过期"，省得管理员为了长期码反复续。
  const hoursRaw = body?.expiresInHours;
  const expiresInHours =
    hoursRaw === null || Number(hoursRaw) <= 0 ? null : Math.min(Math.floor(Number(hoursRaw)), 24 * 365);

  try {
    const { invite, code } = await createInvite({
      note,
      role,
      maxUses: Number.isFinite(maxUses) ? maxUses : 1,
      expiresInHours,
      createdBy: auth.user.username,
    });
    await audit({
      actor: auth.user.username,
      action: "invite_created",
      target: invite.id.slice(0, 8),
      detail: `role=${invite.role} maxUses=${invite.maxUses}`,
      ip: clientKey(request),
    });
    return json({ ok: true, invite, code }, 201);
  } catch (err) {
    return json({ ok: false, error: "internal", message: publicMessage(err, "创建邀请码失败。") }, 500);
  }
}

export async function DELETE(request: Request) {
  if (isCrossSite(request)) return json({ ok: false, error: "cross_site", message: "拒绝跨站调用。" }, 403);
  const auth = await requireAdmin(request);
  if (!auth.ok) return auth.response;

  const id = new URL(request.url).searchParams.get("id") ?? "";
  if (!id) return json({ ok: false, error: "missing_id", message: "缺少邀请码 id。" }, 400);
  try {
    await revokeInvite(id);
    await audit({
      actor: auth.user.username,
      action: "invite_revoked",
      target: id.slice(0, 8),
      ip: clientKey(request),
    });
    return json({ ok: true });
  } catch (err) {
    if (err instanceof AuthStoreError && err.code === "not_found") {
      return json({ ok: false, error: "not_found", message: "邀请码不存在。" }, 404);
    }
    return json({ ok: false, error: "internal", message: publicMessage(err, "撤销邀请码失败。") }, 500);
  }
}
