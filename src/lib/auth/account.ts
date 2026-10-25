import {
  hashAddress,
  hashPassword,
  newSecretToken,
  normalizeUsername,
  passwordProblem,
  verifyPassword,
} from "./crypto";
import {
  AuthStoreError,
  audit,
  checkInvite,
  commitInviteUse,
  createUser,
  deleteUser,
  findUserById,
  findUserByUsername,
  listSessionsForUser,
  listUsers,
  publicUser,
  revokeOtherSessions,
  revokeSessionOfUser,
  revokeUserSessions,
  updateUser,
  type PublicSession,
  type PublicUser,
  type Role,
  type StoredUser,
  type UserStatus,
} from "./store";

/**
 * 账号业务层。
 *
 * 为什么要有这一层：注册、后台建号、改密、重置密码这四条路原来是各自写在 route 里的，
 * 于是"密码要不要随机生成""要不要强制改密""审计写什么""先建号还是先吃邀请码"这些规则
 * 被抄了四份 —— 改一处忘一处，就会出现「后台建的号不强制改密」这种不一致。
 *
 * 这里只做业务判定与落库，**不碰 HTTP**：不解析 request、不拼 Response、不管限流。
 * 路由负责鉴权、限流、JSON 映射；出错一律 throw AccountError，由 accountError() 统一翻成
 * 状态码与中文文案。这样同一段逻辑能被 API、CLI、测试一起用。
 */

export type AccountErrorCode =
  | "bad_username"
  | "bad_password"
  | "duplicate_username"
  | "not_found"
  | "last_admin"
  | "self_delete"
  | "nothing_to_change"
  | "wrong_password"
  | "same_password"
  | "invite_not_found"
  | "invite_revoked"
  | "invite_exhausted"
  | "invite_expired"
  | "store_corrupt";

const STATUS: Record<AccountErrorCode, number> = {
  bad_username: 400,
  bad_password: 400,
  duplicate_username: 409,
  not_found: 404,
  last_admin: 409,
  self_delete: 400,
  nothing_to_change: 400,
  wrong_password: 401,
  same_password: 400,
  invite_not_found: 400,
  invite_revoked: 400,
  invite_exhausted: 400,
  invite_expired: 400,
  store_corrupt: 503,
};

const MESSAGE: Record<AccountErrorCode, string> = {
  bad_username: "用户名只能用 3-32 位小写字母、数字、点、下划线或连字符，且以字母或数字开头。",
  bad_password: "密码至少 10 位。",
  duplicate_username: "这个用户名已被占用。",
  not_found: "用户不存在。",
  last_admin: "这是最后一个可用的管理员，这个操作会把自己锁在门外。",
  self_delete: "不能删除当前登录的自己。",
  nothing_to_change: "没有需要修改的字段。",
  wrong_password: "当前密码不正确。",
  same_password: "新密码不能和当前密码相同。",
  invite_not_found: "邀请码无效。",
  invite_revoked: "邀请码已被撤销。",
  invite_exhausted: "邀请码已用完。",
  invite_expired: "邀请码已过期。",
  store_corrupt: "授权数据文件损坏，请检查服务端日志。",
};

export class AccountError extends Error {
  readonly code: AccountErrorCode;
  /** 文案可以覆盖：密码规则的具体原因（长度 / 含用户名）比一句"至少 10 位"有用。 */
  constructor(code: AccountErrorCode, message?: string) {
    super(message ?? MESSAGE[code]);
    this.name = "AccountError";
    this.code = code;
  }
  get status(): number {
    return STATUS[this.code];
  }
}

/** 把任意异常翻成 {status, code, message}：认得的一律用固定文案，不把内部错误抖给用户。 */
export function accountError(err: unknown, fallback: string): { status: number; code: string; message: string } {
  if (err instanceof AccountError) {
    return { status: err.status, code: err.code, message: err.message };
  }
  if (err instanceof AuthStoreError) {
    const code = err.code as AccountErrorCode;
    if (code in STATUS) return { status: STATUS[code], code, message: MESSAGE[code] };
  }
  return { status: 500, code: "internal", message: fallback };
}

/**
 * 库里抛的错（重名 / 最后一个管理员 / 坏库 / 邀请码并发用完）就地翻成 AccountError，
 * 让路由和测试只需面对一种错误类型。文案沿用 store 里那句 —— 它比通用文案更具体。
 */
function storeError(err: unknown): Error {
  if (err instanceof AuthStoreError) {
    if (err.code === "invite_invalid") return new AccountError("invite_exhausted", err.message);
    const code = err.code as AccountErrorCode;
    if (code in STATUS) return new AccountError(code, err.message || undefined);
  }
  return err instanceof Error ? err : new Error(String(err));
}

const INVITE_BY_REASON: Record<string, AccountErrorCode> = {
  not_found: "invite_not_found",
  revoked: "invite_revoked",
  exhausted: "invite_exhausted",
  expired: "invite_expired",
};

/* -------------------------------- 查询 -------------------------------- */

export async function listAccounts(): Promise<PublicUser[]> {
  return listUsers();
}

export async function accountById(id: string): Promise<PublicUser> {
  const user = await findUserById(id);
  if (!user) throw new AccountError("not_found");
  return publicUser(user);
}

/* -------------------------------- 建号 -------------------------------- */

export type CreateAccountInput = {
  /** 谁建的：管理员用户名，或 "invite:<id>"。 */
  actor: string;
  ip?: string;
  username: string;
  role: Role;
  note?: string;
  /** 留空则随机生成一个（明文只回一次）。 */
  password?: string;
};

/**
 * 后台建号。与注册的差别只在"谁建的"和"要不要改密"：
 * 管理员发的初始密码一定要本人改掉，所以 mustChangePassword 恒为 true。
 */
export async function createAccount(
  input: CreateAccountInput,
): Promise<{ user: PublicUser; generatedPassword?: string }> {
  const username = normalizeUsername(input.username);
  if (!username) throw new AccountError("bad_username");

  const given = (input.password ?? "").trim();
  const generatedPassword = given ? undefined : newSecretToken(12);
  const password = given || generatedPassword || "";
  const problem = passwordProblem(password, username);
  if (problem) throw new AccountError("bad_password", generatedPassword ? "生成的密码不合规：" + problem : problem);

  let user: StoredUser;
  try {
    user = await createUser({
      username,
      passwordHash: await hashPassword(password),
      role: input.role,
      createdBy: input.actor,
      note: (input.note ?? "").slice(0, 200),
      mustChangePassword: true,
    });
  } catch (err) {
    throw storeError(err);
  }
  await audit({
    actor: input.actor,
    action: "user_created",
    target: user.username,
    detail: "role=" + user.role,
    ip: input.ip,
  });
  return { user: publicUser(user), generatedPassword };
}

/* -------------------------------- 改号 -------------------------------- */

export type UpdateAccountInput = {
  actor: string;
  ip?: string;
  id: string;
  role?: Role;
  status?: UserStatus;
  note?: string;
  /** 管理员重置的密码：本人下次登录必须改掉。 */
  newPassword?: string;
  mustChangePassword?: boolean;
};

export async function updateAccount(input: UpdateAccountInput): Promise<{ user: PublicUser; changed: string[] }> {
  const patch: Parameters<typeof updateUser>[1] = {};
  if (input.role) patch.role = input.role;
  if (input.status) patch.status = input.status;
  if (typeof input.note === "string") patch.note = input.note.slice(0, 200);
  if (typeof input.mustChangePassword === "boolean") patch.mustChangePassword = input.mustChangePassword;

  const newPassword = (input.newPassword ?? "").trim();
  if (newPassword) {
    const target = await findUserById(input.id);
    if (!target) throw new AccountError("not_found");
    const problem = passwordProblem(newPassword, target.username);
    if (problem) throw new AccountError("bad_password", problem);
    patch.passwordHash = await hashPassword(newPassword);
    patch.mustChangePassword = true;
  }

  const changed = Object.keys(patch);
  if (changed.length === 0) throw new AccountError("nothing_to_change");

  let user: StoredUser;
  try {
    user = await updateUser(input.id, patch);
  } catch (err) {
    throw storeError(err);
  }
  await audit({
    actor: input.actor,
    action: "user_updated",
    target: user.username,
    detail: changed.join(","),
    ip: input.ip,
  });
  return { user: publicUser(user), changed };
}

export async function deleteAccount(input: {
  actor: string;
  ip?: string;
  selfId: string;
  id: string;
}): Promise<void> {
  if (input.id === input.selfId) throw new AccountError("self_delete");
  const user = await findUserById(input.id);
  if (!user) throw new AccountError("not_found");
  try {
    await deleteUser(input.id);
  } catch (err) {
    throw storeError(err);
  }
  await audit({
    actor: input.actor,
    action: "user_deleted",
    target: user.username,
    ip: input.ip,
  });
}

/* ------------------------------ 邀请码注册 ------------------------------ */

export type RegisterInput = {
  code: string;
  username: string;
  password: string;
  ip?: string;
};

/**
 * 用邀请码注册。
 * 顺序是硬约束：**先建用户、后记名额** —— 反过来一旦建号失败（重名 / 密码不合规），
 * 邀请码就白吃一次，管理员得重新发一个码才能补救。
 */
export async function registerWithInvite(
  input: RegisterInput,
): Promise<{ user: StoredUser; inviteId: string }> {
  const username = normalizeUsername(input.username);
  if (!username) throw new AccountError("bad_username");
  const problem = passwordProblem(input.password, username);
  if (problem) throw new AccountError("bad_password", problem);

  const checked = await checkInvite(input.code);
  if (!checked.ok) {
    await audit({ actor: "signup", action: "invite_rejected", detail: checked.reason, ip: input.ip });
    throw new AccountError(INVITE_BY_REASON[checked.reason] ?? "invite_not_found");
  }
  if (await findUserByUsername(username)) throw new AccountError("duplicate_username");

  let user: StoredUser;
  try {
    user = await createUser({
      username,
      passwordHash: await hashPassword(input.password),
      role: checked.invite.role,
      createdBy: "invite:" + checked.invite.id,
      note: checked.invite.note,
      inviteId: checked.invite.id,
      // 注册的人自己设的密码，没有"初始密码"要改。
      mustChangePassword: false,
    });
  } catch (err) {
    throw storeError(err);
  }
  try {
    await commitInviteUse(checked.invite.id, user.id);
  } catch (err) {
    // 名额在 checks 和 commit 之间被别人用完了：号已经建出来了，交给调用方决定怎么提示。
    throw storeError(err);
  }
  await audit({
    actor: user.username,
    action: "signup",
    target: user.username,
    detail: "invite=" + checked.invite.id.slice(0, 8),
    ip: input.ip,
  });
  return { user, inviteId: checked.invite.id };
}

/* ------------------------------- 自助改密 ------------------------------- */

/**
 * 改密码。返回更新后的用户记录。
 *
 * 注意调用方必须紧接着重新签发会话：updateUser 在密码变化时会撤销该用户的**全部**会话
 * （"改密码就该踢掉其它设备"），包括当前这一枚。
 */
export async function changeOwnPassword(input: {
  user: StoredUser;
  current: string;
  next: string;
  ip?: string;
}): Promise<StoredUser> {
  if (!(await verifyPassword(input.current, input.user.passwordHash))) {
    await audit({ actor: input.user.username, action: "password_failed", ip: input.ip });
    throw new AccountError("wrong_password");
  }
  const problem = passwordProblem(input.next, input.user.username);
  if (problem) throw new AccountError("bad_password", problem);
  if (await verifyPassword(input.next, input.user.passwordHash)) throw new AccountError("same_password");

  const updated = await updateUser(input.user.id, {
    passwordHash: await hashPassword(input.next),
    mustChangePassword: false,
  });
  await audit({
    actor: updated.username,
    action: "password_changed",
    target: updated.username,
    ip: input.ip,
  });
  return updated;
}

/* -------------------------------- 登录设备 -------------------------------- */

/** 自己看的设备列表（管理员看别人走 same 函数，鉴权在路由层）。 */
export async function listDevices(userId: string): Promise<PublicSession[]> {
  return listSessionsForUser(userId);
}

export async function revokeDevice(input: {
  actor: string;
  ip?: string;
  userId: string;
  sessionId: string;
}): Promise<void> {
  const ok = await revokeSessionOfUser(input.userId, input.sessionId);
  if (!ok) throw new AccountError("not_found", "这个会话不存在，或者不属于该用户。");
  await audit({
    actor: input.actor,
    action: "session_revoked",
    target: input.userId,
    detail: "session=" + input.sessionId.slice(0, 8),
    ip: input.ip,
  });
}

export async function revokeOtherDevices(input: {
  actor: string;
  ip?: string;
  userId: string;
  keepSessionId: string;
}): Promise<number> {
  const n = await revokeOtherSessions(input.userId, input.keepSessionId);
  await audit({
    actor: input.actor,
    action: "session_revoked_others",
    target: input.userId,
    detail: "count=" + n,
    ip: input.ip,
  });
  return n;
}

/** 一次性踢掉某个用户的全部会话（管理员视角：「让这人全部重新登录」）。 */
export async function revokeAllDevices(input: {
  actor: string;
  ip?: string;
  userId: string;
}): Promise<number> {
  const n = await revokeUserSessions(input.userId);
  await audit({
    actor: input.actor,
    action: "session_revoked_all",
    target: input.userId,
    detail: "count=" + n,
    ip: input.ip,
  });
  return n;
}

/** 给路由用的 IP 指纹（会话行里只存这个，不存明文地址）。 */
export function deviceFingerprint(ip: string): string {
  return hashAddress(ip);
}
