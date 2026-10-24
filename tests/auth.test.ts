import { test } from "node:test";
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  PASSWORD_MAX,
  PASSWORD_MIN,
  hashAddress,
  hashPassword,
  hashSecret,
  newSecretToken,
  normalizeUsername,
  passwordProblem,
  verifyPassword,
} from "../src/lib/auth/crypto";
import {
  AuthStoreError,
  checkInvite,
  commitInviteUse,
  countAdmins,
  createInvite,
  createSession,
  createUser,
  deleteUser,
  ensureAdminFromEnv,
  findSessionByToken,
  findUserByUsername,
  listAudit,
  listInvites,
  listUsers,
  markLogin,
  revokeInvite,
  revokeUserSessions,
  sessionCount,
  storeFile,
  updateUser,
} from "../src/lib/auth/store";

/**
 * 每个用例组一个独立数据目录：store.ts 的路径是每次调用时读 PROBE_DATA_DIR 算出来的，
 * 所以在 import 之后再设环境变量也来得及（模块顶层不做 I/O，这是当初刻意的设计）。
 */
function freshDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "probe-auth-"));
  process.env.PROBE_DATA_DIR = dir;
  return dir;
}

function readRaw(): any {
  return JSON.parse(readFileSync(storeFile(), "utf8"));
}

function patchRaw(fn: (s: any) => void): void {
  const s = readRaw();
  fn(s);
  writeFileSync(storeFile(), JSON.stringify(s, null, 2), "utf8");
}

const FAST = "correct horse battery";

/* ------------------------------- 密码哈希 ------------------------------- */

test("hashPassword：格式带参数、能验证、同一密码两次结果不同", async () => {
  const a = await hashPassword(FAST);
  const b = await hashPassword(FAST);
  assert.match(a, /^scrypt\$N=16384,r=8,p=1\$[A-Za-z0-9_-]{20,}\$[A-Za-z0-9_-]{40,}$/);
  assert.notEqual(a, b, "每次都要换新 salt");
  assert.equal(await verifyPassword(FAST, a), true);
  assert.equal(await verifyPassword(FAST + "x", a), false);
  assert.equal(await verifyPassword(FAST, b), true);
});

test("verifyPassword：脏记录一律 false，不抛异常", async () => {
  const good = await hashPassword(FAST);
  const [, params, salt, hash] = good.split("$");
  const cases = [
    "",
    "plain-text",
    "scrypt$only-three$parts",
    `bcrypt$${params}$${salt}$${hash}`,
    // N 不是 2 的幂 / 超出上限：不能让库里的脏记录把进程内存打爆
    `scrypt$N=3,r=8,p=1$${salt}$${hash}`,
    `scrypt$N=2097152,r=8,p=1$${salt}$${hash}`,
    `scrypt$N=16384,r=99,p=1$${salt}$${hash}`,
    `scrypt$N=16384,p=1$${salt}$${hash}`,
    `scrypt$N=16384,r=8,p=1$c2hvcnQ$${hash}`,
  ];
  for (const stored of cases) {
    assert.equal(await verifyPassword(FAST, stored), false, stored);
  }
});

test("hashSecret / hashAddress / newSecretToken", () => {
  const token = newSecretToken();
  assert.equal(token.length, 43, "32 字节 base64url 是 43 个字符");
  assert.ok(!token.includes("="));
  assert.match(hashSecret("abc"), /^[0-9a-f]{64}$/);
  assert.equal(hashSecret("abc"), hashSecret("abc"));
  assert.notEqual(hashSecret("abc"), hashSecret("abd"));
  // IP 只留指纹：16 位十六进制，够比对、不足以还原地址
  assert.match(hashAddress("203.0.113.7"), /^[0-9a-f]{16}$/);
  assert.notEqual(hashAddress("203.0.113.7"), hashAddress("203.0.113.8"));
});

test("passwordProblem：长度、首尾空格、连续空格、包含用户名", () => {
  assert.equal(passwordProblem("a".repeat(PASSWORD_MIN), "someone"), null);
  assert.match(passwordProblem("a".repeat(PASSWORD_MIN - 1), "someone") ?? "", /至少/);
  assert.match(passwordProblem("a".repeat(PASSWORD_MAX + 1), "someone") ?? "", /最长/);
  assert.match(passwordProblem(" hunter2hunter2", "someone") ?? "", /空格/);
  assert.match(passwordProblem("hunter2  hunter2", "someone") ?? "", /空格/);
  assert.match(passwordProblem("xx-ALICE-yy", "alice") ?? "", /用户名/);
});

test("normalizeUsername：小写、字符集、首尾连字符", () => {
  assert.equal(normalizeUsername("  Alice.01 "), "alice.01");
  assert.equal(normalizeUsername("ab"), null, "太短");
  assert.equal(normalizeUsername("a".repeat(33)), null, "太长");
  assert.equal(normalizeUsername("-abc"), null);
  assert.equal(normalizeUsername("abc-"), null);
  assert.equal(normalizeUsername("中文用户"), null);
  assert.equal(normalizeUsername("a b"), null);
});

/* -------------------------------- 用户 -------------------------------- */

test("createUser / findUserByUsername：重名拒绝，列表不带密码哈希", async () => {
  freshDir();
  const hash = await hashPassword(FAST);
  const user = await createUser({ username: "alice", passwordHash: hash, createdBy: "test" });
  assert.equal(user.role, "member");
  assert.equal(user.status, "active");

  await assert.rejects(
    () => createUser({ username: "alice", passwordHash: hash, createdBy: "test" }),
    (err: unknown) => err instanceof AuthStoreError && err.code === "duplicate_username",
  );

  const found = await findUserByUsername("alice");
  assert.equal(found?.id, user.id);
  assert.equal(found?.passwordHash, hash);

  const pub = await listUsers();
  assert.equal(pub.length, 1);
  // 关键：给前端的视图里不能有 passwordHash —— 有它等于把离线爆破材料发出去
  assert.equal((pub[0] as Record<string, unknown>).passwordHash, undefined);
  assert.equal(pub[0]?.sessions, 0);
});

test("最后一个管理员不能被降级 / 停用 / 删除", async () => {
  freshDir();
  const hash = await hashPassword(FAST);
  const admin = await createUser({ username: "root", passwordHash: hash, role: "admin", createdBy: "test" });

  await assert.rejects(
    () => updateUser(admin.id, { role: "member" }),
    (err: unknown) => err instanceof AuthStoreError && err.code === "last_admin",
  );
  await assert.rejects(
    () => updateUser(admin.id, { status: "disabled" }),
    (err: unknown) => err instanceof AuthStoreError && err.code === "last_admin",
  );
  await assert.rejects(
    () => deleteUser(admin.id),
    (err: unknown) => err instanceof AuthStoreError && err.code === "last_admin",
  );

  // 有第二个管理员之后，前一个就可以被处理了
  await createUser({ username: "root2", passwordHash: hash, role: "admin", createdBy: "test" });
  assert.equal(await countAdmins(), 2);
  await updateUser(admin.id, { role: "member" });
  assert.equal(await countAdmins(), 1);
});

test("停用用户会立刻撤销他的全部会话", async () => {
  freshDir();
  const hash = await hashPassword(FAST);
  const user = await createUser({ username: "bob", passwordHash: hash, createdBy: "test" });
  const s1 = await createSession({ userId: user.id, ttlMs: 3_600_000, ipHash: "x", userAgent: "t" });
  assert.equal((await findSessionByToken(s1.token)).ok, true);
  assert.equal(await sessionCount(user.id), 1);

  await updateUser(user.id, { status: "disabled" });
  const after = await findSessionByToken(s1.token);
  assert.equal(after.ok, false);
  assert.equal(after.ok === false && after.reason, "revoked");
  assert.equal(await sessionCount(user.id), 0);
});

test("findSessionByToken：过期 / 停用 / 伪造 token 分别给出原因", async () => {
  freshDir();
  const hash = await hashPassword(FAST);
  const user = await createUser({ username: "carol", passwordHash: hash, createdBy: "test" });
  const live = await createSession({ userId: user.id, ttlMs: 3_600_000, ipHash: "x", userAgent: "t" });
  const stale = await createSession({ userId: user.id, ttlMs: 3_600_000, ipHash: "x", userAgent: "t" });

  assert.equal((await findSessionByToken("short")).ok, false);
  assert.equal((await findSessionByToken(newSecretToken(32))).ok, false);

  // 直接把库里那条会话改成已过期，比等一小时现实
  patchRaw((s) => {
    for (const sess of s.sessions) if (sess.id === stale.sessionId) sess.expiresAt = Date.now() - 1000;
  });
  const expired = await findSessionByToken(stale.token);
  assert.equal(expired.ok === false && expired.reason, "expired");

  // 用户被停用但会话本身还没被撤销：必须按 disabled 拒绝
  patchRaw((s) => {
    for (const u of s.users) if (u.id === user.id) u.status = "disabled";
  });
  const disabled = await findSessionByToken(live.token);
  assert.equal(disabled.ok === false && disabled.reason, "disabled");
});

test("markLogin 只动时间，不碰密码", async () => {
  freshDir();
  const hash = await hashPassword(FAST);
  const user = await createUser({ username: "dave", passwordHash: hash, createdBy: "test" });
  assert.equal(user.lastLoginAt, null);
  await markLogin(user.id);
  const after = await findUserByUsername("dave");
  assert.ok(typeof after?.lastLoginAt === "number");
  assert.equal(after?.passwordHash, hash);
});

/* ------------------------------- 邀请码 ------------------------------- */

test("邀请码两阶段：先验证后记账，名额不会被白吃", async () => {
  freshDir();
  const { invite, code } = await createInvite({ maxUses: 1, expiresInHours: 24, createdBy: "test" });
  assert.equal(invite.uses, 0);
  assert.equal(invite.maxUses, 1);
  assert.ok(code.length >= 20);

  // 明文不入库：库里只应有 codeHash
  const raw = readRaw();
  assert.equal(raw.invites[0].code, undefined);
  assert.match(raw.invites[0].codeHash, /^[0-9a-f]{64}$/);

  const first = await checkInvite(code);
  assert.equal(first.ok, true);
  // 反复 check 不该消耗名额
  assert.equal((await checkInvite(code)).ok, true);
  assert.equal(readRaw().invites[0].uses, 0);

  const hash = await hashPassword(FAST);
  const user = await createUser({ username: "erin", passwordHash: hash, createdBy: "test" });
  await commitInviteUse(invite.id, user.id);
  assert.equal(readRaw().invites[0].uses, 1);

  const second = await checkInvite(code);
  assert.equal(second.ok === false && second.reason, "exhausted");
});

test("邀请码：撤销 / 过期 / 不存在各自的原因码", async () => {
  freshDir();
  const a = await createInvite({ maxUses: 5, expiresInHours: 24, createdBy: "test" });
  await revokeInvite(a.invite.id);
  assert.equal((await checkInvite(a.code)).ok === false && (await checkInvite(a.code) as any).reason, "revoked");

  const b = await createInvite({ maxUses: 5, expiresInHours: 24, createdBy: "test" });
  patchRaw((s) => {
    for (const inv of s.invites) if (inv.id === b.invite.id) inv.expiresAt = Date.now() - 1000;
  });
  assert.equal((await checkInvite(b.code) as any).reason, "expired");

  assert.equal((await checkInvite(newSecretToken(20)) as any).reason, "not_found");
  assert.equal((await checkInvite("short") as any).reason, "not_found");

  const list = await listInvites();
  assert.equal(list.length, 2);
  assert.equal((list[0] as Record<string, unknown>).codeHash, undefined);
});

/* -------------------------------- 其它 -------------------------------- */

test("ensureAdminFromEnv：空库种一次，已有用户后不再覆盖", async () => {
  freshDir();
  process.env.PROBE_ADMIN_USER = "Bootstrap.Admin";
  process.env.PROBE_ADMIN_PASSWORD = "bootstrap-password-1";
  try {
    const first = await ensureAdminFromEnv();
    assert.equal(first.created, true);
    assert.equal(first.username, "bootstrap.admin");
    const seeded = await findUserByUsername("bootstrap.admin");
    assert.equal(seeded?.role, "admin");
    assert.equal(seeded?.mustChangePassword, true);

    const second = await ensureAdminFromEnv();
    assert.equal(second.created, false, "库里有用户时绝不重复种");
    assert.equal((await listUsers()).length, 1);
  } finally {
    delete process.env.PROBE_ADMIN_USER;
    delete process.env.PROBE_ADMIN_PASSWORD;
  }
});

test("ensureAdminFromEnv：弱密码 / 非法用户名都不种", async () => {
  freshDir();
  process.env.PROBE_ADMIN_USER = "ab";
  process.env.PROBE_ADMIN_PASSWORD = "short";
  try {
    assert.equal((await ensureAdminFromEnv()).created, false);
    assert.equal((await listUsers()).length, 0);
  } finally {
    delete process.env.PROBE_ADMIN_USER;
    delete process.env.PROBE_ADMIN_PASSWORD;
  }
});

test("审计：倒序返回，明细里的 IP 只留指纹", async () => {
  freshDir();
  const { audit } = await import("../src/lib/auth/store");
  await audit({ actor: "alice", action: "login", ip: "203.0.113.9" });
  await audit({ actor: "bob", action: "login_failed", target: "alice" });
  const rows = await listAudit(10);
  assert.equal(rows.length, 2);
  assert.equal(rows[0]?.actor, "bob", "最新的在第一条");
  assert.ok(rows[1]?.detail.includes("ip="), rows[1]?.detail);
  assert.ok(!rows[1]?.detail.includes("203.0.113.9"), "不能留明文地址");
});

test("store 损坏时抛 store_corrupt，绝不回退成空库", async () => {
  const dir = freshDir();
  const { mkdirSync } = await import("node:fs");
  mkdirSync(path.join(dir, "auth"), { recursive: true });
  writeFileSync(storeFile(), "{ oops", "utf8");
  await assert.rejects(
    () => listUsers(),
    (err: unknown) => err instanceof AuthStoreError && err.code === "store_corrupt",
  );
});

test("CLI 生成的哈希必须能被 verifyPassword 接受", async () => {
  const dir = freshDir();
  const script = path.join(process.cwd(), "scripts", "auth-cli.mjs");
  const password = "cli-generated-pass-1";
  execFileSync(process.execPath, [script, "create-admin", "cliadmin", "--password", password], {
    env: { ...process.env, PROBE_DATA_DIR: dir },
    stdio: "pipe",
  });

  const raw = readRaw();
  const created = raw.users.find((u: any) => u.username === "cliadmin");
  assert.ok(created, "CLI 应该写进同一个 store.json");
  assert.equal(created.role, "admin");
  assert.equal(await verifyPassword(password, created.passwordHash), true);
  assert.equal(await verifyPassword(password + "x", created.passwordHash), false);

  // 反过来：服务端写的哈希，CLI 的 list 要能读出来
  const out = execFileSync(process.execPath, [script, "list"], {
    env: { ...process.env, PROBE_DATA_DIR: dir },
    stdio: "pipe",
  });
  assert.ok(out.toString("utf8").includes("cliadmin"));
});

test("会话：revokeUserSessions 返回撤销条数", async () => {
  freshDir();
  const hash = await hashPassword(FAST);
  const user = await createUser({ username: "frank", passwordHash: hash, createdBy: "test" });
  const a = await createSession({ userId: user.id, ttlMs: 3_600_000, ipHash: "x", userAgent: "t" });
  await createSession({ userId: user.id, ttlMs: 3_600_000, ipHash: "x", userAgent: "t" });
  assert.equal(await revokeUserSessions(user.id), 2);
  assert.equal(await revokeUserSessions(user.id), 0, "已经撤销过的不重复计数");
  assert.equal((await findSessionByToken(a.token)).ok, false);
  assert.equal(await sessionCount(user.id), 0);
});
