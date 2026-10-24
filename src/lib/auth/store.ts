import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { hashAddress, hashSecret, newSecretToken } from "./crypto";

/**
 * 授权数据的存储层 —— 一个进程内互斥、原子落盘的 JSON 文件。
 *
 * 为什么不是数据库：这是测试服务器，用户量在几十到几百，读改写的热点只有
 * "登录"和"管理员点按钮"，一天几十次。为此引一个 SQLite 依赖、再处理
 * Turbopack 对 `node:sqlite` 的打包行为，换来的复杂度远大于收益。
 *
 * 但"用文件"不等于"随便写"：
 * - 所有读改写都过同一个 Promise 队列，两个管理员同时点保存不会互相覆盖；
 * - 落盘是 tmp + rename（同一分区上原子），写一半断电不会留下半个 JSON；
 * - 文件 0600、目录 0700；
 * - **解析失败直接抛错，绝不回退成空库** —— 一次坏的读取把全站用户清空，
 *   比让服务 500 危险得多。`docs/AUTH.md` 写了怎么手工修。
 *
 * 库里存的都是哈希：密码 scrypt、会话 token 与邀请码 SHA-256、审计 IP 短哈希。
 * 拿到 store.json 的人没法直接登录，也没法复制出一个能用的会话。
 */

export type Role = "admin" | "member";
export type UserStatus = "active" | "disabled";

export type StoredUser = {
  id: string;
  username: string;
  role: Role;
  status: UserStatus;
  passwordHash: string;
  createdAt: number;
  createdBy: string;
  updatedAt: number;
  lastLoginAt: number | null;
  /** 管理员代建的账号：首次登录后提示改密码。 */
  mustChangePassword: boolean;
  note: string;
  inviteId: string | null;
  usage: { day: string; calls: number };
};

export type StoredInvite = {
  id: string;
  /** 明文只在生成时返回一次，库里只留 SHA-256。 */
  codeHash: string;
  note: string;
  role: Role;
  maxUses: number;
  uses: number;
  expiresAt: number | null;
  createdAt: number;
  createdBy: string;
  revoked: boolean;
  usedBy: { userId: string; at: number }[];
};

export type StoredSession = {
  id: string;
  tokenHash: string;
  userId: string;
  createdAt: number;
  expiresAt: number;
  lastSeenAt: number;
  ipHash: string;
  userAgent: string;
  revoked: boolean;
};

export type AuditEntry = {
  at: number;
  actor: string;
  action: string;
  target: string;
  detail: string;
};

type Store = {
  version: 1;
  users: StoredUser[];
  invites: StoredInvite[];
  sessions: StoredSession[];
  audit: AuditEntry[];
};

/** 给前端用的用户视图：去掉 passwordHash，附上活跃会话数。 */
export type PublicUser = Omit<StoredUser, "passwordHash"> & { sessions: number };
export type PublicInvite = Omit<StoredInvite, "codeHash">;

export type StoreErrorCode =
  | "not_found"
  | "duplicate_username"
  | "last_admin"
  | "invite_invalid"
  | "store_corrupt";

export class AuthStoreError extends Error {
  readonly code: StoreErrorCode;
  constructor(code: StoreErrorCode, message: string) {
    super(message);
    this.name = "AuthStoreError";
    this.code = code;
  }
}

const AUDIT_CAP = 2_000;

function dataDir(): string {
  return process.env.PROBE_DATA_DIR?.trim() || path.join(process.cwd(), ".data");
}

export function storeFile(): string {
  return path.join(dataDir(), "auth", "store.json");
}

function emptyStore(): Store {
  return { version: 1, users: [], invites: [], sessions: [], audit: [] };
}

/* ------------------------------ 文件读写 ------------------------------ */

let queue: Promise<unknown> = Promise.resolve();

/** 进程内串行化：读-改-写这段不能被另一个请求插进来。 */
function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function readStore(): Promise<Store> {
  const file = storeFile();
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return emptyStore();
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // 关键：坏文件不能当成空库。空库会让 bootstrap 重新种一个管理员，
    // 用户以为自己被删光了，实际是少了一个逗号。
    throw new AuthStoreError(
      "store_corrupt",
      `授权数据文件解析失败：${file}。请先备份并人工修复（格式见 docs/AUTH.md）。`,
    );
  }
  const s = parsed as Partial<Store>;
  if (!s || typeof s !== "object" || !Array.isArray(s.users)) {
    throw new AuthStoreError("store_corrupt", `授权数据文件结构不对：${file}`);
  }
  return {
    version: 1,
    users: s.users as StoredUser[],
    invites: Array.isArray(s.invites) ? (s.invites as StoredInvite[]) : [],
    sessions: Array.isArray(s.sessions) ? (s.sessions as StoredSession[]) : [],
    audit: Array.isArray(s.audit) ? (s.audit as AuditEntry[]) : [],
  };
}

let tmpCounter = 0;

async function writeStore(s: Store): Promise<void> {
  const file = storeFile();
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const now = Date.now();
  s.sessions = s.sessions.filter((x) => x.expiresAt > now);
  if (s.audit.length > AUDIT_CAP) s.audit = s.audit.slice(-AUDIT_CAP);
  const tmp = `${file}.tmp-${process.pid}-${++tmpCounter}`;
  await fs.writeFile(tmp, JSON.stringify(s, null, 2), { encoding: "utf8", mode: 0o600 });
  await fs.rename(tmp, file);
  // rename 保留 tmp 的权限，但 umask 因机器而异，显式再钉一次。
  await fs.chmod(file, 0o600).catch(() => undefined);
}

/** 读-改-写。mutator 的返回值原样透出。 */
async function mutate<T>(fn: (s: Store) => T | Promise<T>): Promise<T> {
  return serialize(async () => {
    const s = await readStore();
    const out = await fn(s);
    await writeStore(s);
    return out;
  });
}

async function read<T>(fn: (s: Store) => T): Promise<T> {
  const s = await readStore();
  return fn(s);
}

/* -------------------------------- 用户 -------------------------------- */

export function todayKey(at = Date.now()): string {
  return new Date(at).toISOString().slice(0, 10);
}

function toPublic(u: StoredUser, sessionCount: number): PublicUser {
  const { passwordHash: _drop, ...rest } = u;
  void _drop;
  return { ...rest, sessions: sessionCount };
}

function liveSessionCount(s: Store, userId: string): number {
  const now = Date.now();
  return s.sessions.filter((x) => x.userId === userId && !x.revoked && x.expiresAt > now).length;
}

export async function listUsers(): Promise<PublicUser[]> {
  return read((s) =>
    s.users
      .slice()
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((u) => toPublic(u, liveSessionCount(s, u.id))),
  );
}

export async function findUserById(id: string): Promise<StoredUser | null> {
  return read((s) => s.users.find((u) => u.id === id) ?? null);
}

export async function findUserByUsername(username: string): Promise<StoredUser | null> {
  return read((s) => s.users.find((u) => u.username === username) ?? null);
}

export async function countUsers(): Promise<number> {
  return read((s) => s.users.length);
}

export async function countAdmins(): Promise<number> {
  return read((s) => s.users.filter((u) => u.role === "admin" && u.status === "active").length);
}

export async function createUser(input: {
  username: string;
  passwordHash: string;
  role?: Role;
  createdBy: string;
  note?: string;
  inviteId?: string | null;
  mustChangePassword?: boolean;
}): Promise<StoredUser> {
  return mutate((s) => {
    if (s.users.some((u) => u.username === input.username)) {
      throw new AuthStoreError("duplicate_username", `用户名 ${input.username} 已存在。`);
    }
    const now = Date.now();
    const user: StoredUser = {
      id: randomUUID(),
      username: input.username,
      role: input.role === "admin" ? "admin" : "member",
      status: "active",
      passwordHash: input.passwordHash,
      createdAt: now,
      createdBy: input.createdBy,
      updatedAt: now,
      lastLoginAt: null,
      mustChangePassword: input.mustChangePassword === true,
      note: (input.note ?? "").slice(0, 200),
      inviteId: input.inviteId ?? null,
      usage: { day: todayKey(now), calls: 0 },
    };
    s.users.push(user);
    return user;
  });
}

export type UserPatch = {
  status?: UserStatus;
  role?: Role;
  passwordHash?: string;
  note?: string;
  mustChangePassword?: boolean;
};

export async function updateUser(id: string, patch: UserPatch): Promise<StoredUser> {
  return mutate((s) => {
    const user = s.users.find((u) => u.id === id);
    if (!user) throw new AuthStoreError("not_found", "用户不存在。");

    // 把最后一个可用管理员降级/停用 = 把自己锁在门外，且没人能救。
    if ((patch.role === "member" || patch.status === "disabled") && user.role === "admin") {
      const otherAdmins = s.users.filter(
        (u) => u.id !== id && u.role === "admin" && u.status === "active",
      );
      if (otherAdmins.length === 0) {
        throw new AuthStoreError("last_admin", "这是最后一个可用的管理员，不能降级或停用。");
      }
    }

    if (patch.role) user.role = patch.role;
    if (patch.status) user.status = patch.status;
    if (patch.passwordHash) user.passwordHash = patch.passwordHash;
    if (patch.note !== undefined) user.note = patch.note.slice(0, 200);
    if (patch.mustChangePassword !== undefined) user.mustChangePassword = patch.mustChangePassword;
    user.updatedAt = Date.now();

    // 停用或改密码之后，已发出去的会话必须立刻失效 —— 否则"禁用"只是看着禁用。
    if (patch.status === "disabled" || patch.passwordHash) {
      for (const sess of s.sessions) {
        if (sess.userId === id) sess.revoked = true;
      }
    }
    return user;
  });
}

export async function deleteUser(id: string): Promise<void> {
  await mutate((s) => {
    const user = s.users.find((u) => u.id === id);
    if (!user) throw new AuthStoreError("not_found", "用户不存在。");
    if (user.role === "admin") {
      const otherAdmins = s.users.filter(
        (u) => u.id !== id && u.role === "admin" && u.status === "active",
      );
      if (otherAdmins.length === 0) {
        throw new AuthStoreError("last_admin", "这是最后一个可用的管理员，不能删除。");
      }
    }
    s.users = s.users.filter((u) => u.id !== id);
    s.sessions = s.sessions.filter((x) => x.userId !== id);
  });
}

/** 登录成功：记时间、清零当日用量基线（跨天时）。 */
export async function markLogin(id: string): Promise<void> {
  await mutate((s) => {
    const user = s.users.find((u) => u.id === id);
    if (!user) return;
    user.lastLoginAt = Date.now();
    const day = todayKey();
    if (user.usage.day !== day) user.usage = { day, calls: 0 };
  });
}

/**
 * 通过鉴权的请求计数，用于后台看"谁在用"。
 * `by` 是合并写入用的批量值 —— guard 会把短时间内的多次调用攒起来一次落盘，
 * 所以这个数字是近似的，不要拿它当计费依据。
 */
export async function bumpUsage(id: string, by = 1): Promise<void> {
  const delta = Math.max(1, Math.floor(by));
  await mutate((s) => {
    const user = s.users.find((u) => u.id === id);
    if (!user) return;
    const day = todayKey();
    if (user.usage.day !== day) user.usage = { day, calls: delta };
    else user.usage.calls += delta;
  });
}

/* ------------------------------- 邀请码 ------------------------------- */

export async function createInvite(input: {
  note?: string;
  role?: Role;
  maxUses?: number;
  expiresInHours?: number | null;
  createdBy: string;
}): Promise<{ invite: PublicInvite; code: string }> {
  // 20 字节 = 160 位随机，base64url 27 个字符，抄写/复制都够用。
  const code = newSecretToken(20);
  const maxUses = Math.min(Math.max(Math.floor(input.maxUses ?? 1), 1), 200);
  const hours = input.expiresInHours ?? 72;
  const now = Date.now();
  const invite = await mutate((s) => {
    const row: StoredInvite = {
      id: randomUUID(),
      codeHash: hashSecret(code),
      note: (input.note ?? "").slice(0, 120),
      role: input.role === "admin" ? "admin" : "member",
      maxUses,
      uses: 0,
      expiresAt: hours === null ? null : now + Math.min(Math.max(hours, 1), 24 * 365) * 3_600_000,
      createdAt: now,
      createdBy: input.createdBy,
      revoked: false,
      usedBy: [],
    };
    s.invites.push(row);
    return row;
  });
  const { codeHash: _drop, ...pub } = invite;
  void _drop;
  return { invite: pub, code };
}

export async function listInvites(): Promise<PublicInvite[]> {
  return read((s) =>
    s.invites
      .slice()
      .sort((a, b) => b.createdAt - a.createdAt)
      .map(({ codeHash: _drop, ...rest }) => {
        void _drop;
        return rest;
      }),
  );
}

export async function revokeInvite(id: string): Promise<void> {
  await mutate((s) => {
    const inv = s.invites.find((x) => x.id === id);
    if (!inv) throw new AuthStoreError("not_found", "邀请码不存在。");
    inv.revoked = true;
  });
}

export type RedeemResult =
  | { ok: true; invite: PublicInvite }
  | { ok: false; reason: "not_found" | "revoked" | "exhausted" | "expired" };

/**
 * 用邀请码占一个名额。返回的 invite 是"已验证但还没记账"的视图 ——
 * 调用方要在用户创建成功之后再调 `commitInviteUse`，否则建号失败会白吃掉一个名额。
 */
export async function checkInvite(code: string): Promise<RedeemResult> {
  const trimmed = (code ?? "").trim();
  if (trimmed.length < 8 || trimmed.length > 128) return { ok: false, reason: "not_found" };
  const codeHash = hashSecret(trimmed);
  const found = await read((s) => s.invites.find((x) => x.codeHash === codeHash) ?? null);
  if (!found) return { ok: false, reason: "not_found" };
  if (found.revoked) return { ok: false, reason: "revoked" };
  if (found.expiresAt !== null && found.expiresAt <= Date.now()) return { ok: false, reason: "expired" };
  if (found.uses >= found.maxUses) return { ok: false, reason: "exhausted" };
  const { codeHash: _drop, ...pub } = found;
  void _drop;
  return { ok: true, invite: pub };
}

export async function commitInviteUse(inviteId: string, userId: string): Promise<void> {
  await mutate((s) => {
    const inv = s.invites.find((x) => x.id === inviteId);
    if (!inv) throw new AuthStoreError("invite_invalid", "邀请码不存在。");
    if (inv.uses >= inv.maxUses) throw new AuthStoreError("invite_invalid", "邀请码已用完。");
    inv.uses += 1;
    inv.usedBy.push({ userId, at: Date.now() });
  });
}

/* -------------------------------- 会话 -------------------------------- */

export async function createSession(input: {
  userId: string;
  ttlMs: number;
  ipHash: string;
  userAgent: string;
}): Promise<{ token: string; expiresAt: number; sessionId: string }> {
  const token = newSecretToken(32);
  const now = Date.now();
  const expiresAt = now + input.ttlMs;
  const sessionId = await mutate((s) => {
    const row: StoredSession = {
      id: randomUUID(),
      tokenHash: hashSecret(token),
      userId: input.userId,
      createdAt: now,
      expiresAt,
      lastSeenAt: now,
      ipHash: input.ipHash,
      userAgent: input.userAgent.slice(0, 200),
      revoked: false,
    };
    s.sessions.push(row);
    return row.id;
  });
  return { token, expiresAt, sessionId };
}

export type SessionLookup =
  | { ok: true; session: StoredSession; user: StoredUser }
  | { ok: false; reason: "none" | "expired" | "revoked" | "disabled" };

export async function findSessionByToken(token: string): Promise<SessionLookup> {
  if (!token || token.length < 20) return { ok: false, reason: "none" };
  const tokenHash = hashSecret(token);
  return read((s) => {
    const session = s.sessions.find((x) => x.tokenHash === tokenHash);
    if (!session) return { ok: false, reason: "none" } as SessionLookup;
    if (session.revoked) return { ok: false, reason: "revoked" } as SessionLookup;
    if (session.expiresAt <= Date.now()) return { ok: false, reason: "expired" } as SessionLookup;
    const user = s.users.find((u) => u.id === session.userId);
    if (!user) return { ok: false, reason: "none" } as SessionLookup;
    if (user.status !== "active") return { ok: false, reason: "disabled" } as SessionLookup;
    return { ok: true, session, user } as SessionLookup;
  });
}

const TOUCH_WINDOW_MS = 5 * 60_000;
const touched = new Map<string, number>();

/**
 * 滑动续期（"最近活跃时间"）。5 分钟内的重复调用直接返回 ——
 * 关键是在**进程内**就挡掉，不然 mongoose 式的 mutate 每个请求都要写一次盘。
 */
export async function touchSession(sessionId: string): Promise<void> {
  const now = Date.now();
  if (now - (touched.get(sessionId) ?? 0) < TOUCH_WINDOW_MS) return;
  touched.set(sessionId, now);
  if (touched.size > 5_000) touched.clear();
  await mutate((s) => {
    const sess = s.sessions.find((x) => x.id === sessionId);
    if (sess) sess.lastSeenAt = now;
  });
}

export async function revokeSession(sessionId: string): Promise<void> {
  await mutate((s) => {
    const sess = s.sessions.find((x) => x.id === sessionId);
    if (sess) sess.revoked = true;
  });
}

export async function revokeUserSessions(userId: string): Promise<number> {
  return mutate((s) => {
    let n = 0;
    for (const sess of s.sessions) {
      if (sess.userId === userId && !sess.revoked) {
        sess.revoked = true;
        n += 1;
      }
    }
    return n;
  });
}

export async function sessionCount(userId: string): Promise<number> {
  return read((s) => liveSessionCount(s, userId));
}

/* ------------------------------ 审计 / 启动 ------------------------------ */

export async function audit(entry: {
  actor: string;
  action: string;
  target?: string;
  detail?: string;
  ip?: string;
}): Promise<void> {
  await mutate((s) => {
    s.audit.push({
      at: Date.now(),
      actor: entry.actor.slice(0, 64),
      action: entry.action.slice(0, 48),
      target: (entry.target ?? "").slice(0, 120),
      detail: (entry.ip ? ship(entry.detail, entry.ip) : (entry.detail ?? "")).slice(0, 300),
    });
  });
}

/** 审计里的 IP 只留指纹：能比对"同一个人干了三次"，但留不下地址。 */
function ship(detail: string | undefined, ip: string): string {
  const base = detail ? detail + " " : "";
  return `${base}ip=${hashAddress(ip)}`;
}

export async function listAudit(limit = 200): Promise<AuditEntry[]> {
  return read((s) => s.audit.slice(-Math.min(Math.max(limit, 1), AUDIT_CAP)).reverse());
}

/** 新库时用环境变量种一个管理员；已有用户则什么都不做（绝不覆盖）。 */
export async function ensureAdminFromEnv(): Promise<{ created: boolean; username?: string }> {
  const username = process.env.PROBE_ADMIN_USER?.trim();
  const password = process.env.PROBE_ADMIN_PASSWORD;
  if (!username || !password) return { created: false };
  const { normalizeUsername, hashPassword, passwordProblem } = await import("./crypto");
  const name = normalizeUsername(username);
  if (!name) return { created: false };
  const problem = passwordProblem(password, name);
  if (problem) return { created: false };
  const existing = await findUserByUsername(name);
  if (existing) return { created: false };
  const total = await countUsers();
  if (total > 0) return { created: false };
  await createUser({
    username: name,
    passwordHash: await hashPassword(password),
    role: "admin",
    createdBy: "env:bootstrap",
    note: "环境变量初始化",
    mustChangePassword: true,
  });
  return { created: true, username: name };
}
