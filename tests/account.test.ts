import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { hashPassword, verifyPassword } from "../src/lib/auth/crypto";
import {
  AuthStoreError,
  createInvite,
  createSession,
  createUser,
  findSessionByToken,
  findUserById,
  findUserByUsername,
  listAudit,
  listUsers,
  sessionCount,
  updateUser,
} from "../src/lib/auth/store";
import {
  AccountError,
  accountError,
  changeOwnPassword,
  createAccount,
  deleteAccount,
  listDevices,
  registerWithInvite,
  revokeDevice,
  revokeOtherDevices,
  updateAccount,
} from "../src/lib/auth/account";

/**
 * 账号业务层的测试。
 *
 * 这些规则以前散在四个 route 里，改一处忘一处 —— 现在只有 account.ts 一份，
 * 所以规则本身值得逐个钉死：生成的密码能用、改密必须重新签发、邀请码不能被白吃、
 * 最后一个管理员不能被弄没。
 */

function freshDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "probe-account-"));
  process.env.PROBE_DATA_DIR = dir;
  return dir;
}

async function plainUser(username = "member-one"): Promise<string> {
  const u = await createUser({
    username,
    passwordHash: await hashPassword("correct horse battery"),
    role: "member",
    createdBy: "test",
    mustChangePassword: false,
  });
  return u.id;
}

/* ------------------------------ createAccount ------------------------------ */

test("createAccount 留空密码时生成一个可用的初始密码，并强制改密", async () => {
  freshDir();
  const { user, generatedPassword } = await createAccount({
    actor: "admin",
    ip: "1.2.3.4",
    username: "New-Member",
    role: "member",
    note: "测试账号",
  });

  assert.ok(generatedPassword && generatedPassword.length >= 10, "应当生成初始密码");
  assert.equal(user.username, "new-member", "用户名统一小写");
  assert.equal(user.mustChangePassword, true, "管理员发的初始密码必须本人改掉");
  assert.equal(user.note, "测试账号");
  assert.ok(!("passwordHash" in user), "对外视图不能带密码哈希");

  // 生成的那个密码必须真的能登录 —— 否则管理员把一串没用的字符发出去。
  const stored = await findUserById(user.id);
  assert.ok(stored);
  assert.equal(await verifyPassword(generatedPassword as string, stored.passwordHash), true);

  const audited = await listAudit(10);
  assert.ok(audited.some((e) => e.action === "user_created" && e.target === "new-member"));
  assert.ok(audited.every((e) => !JSON.stringify(e).includes("password=")), "审计里不能落明文密码");
});

test("createAccount 指定密码时校验规则，不合规不给建", async () => {
  freshDir();
  const ok = await createAccount({ actor: "admin", username: "with-pass", role: "member", password: "long enough password" });
  assert.equal(ok.generatedPassword, undefined);
  const stored = await findUserById(ok.user.id);
  assert.ok(stored);
  assert.equal(await verifyPassword("long enough password", stored.passwordHash), true);

  await assert.rejects(
    () => createAccount({ actor: "admin", username: "short-pass", role: "member", password: "short" }),
    (err: unknown) => err instanceof AccountError && err.code === "bad_password",
  );
  await assert.rejects(
    () => createAccount({ actor: "admin", username: "bad name!", role: "member", password: "long enough password" }),
    (err: unknown) => err instanceof AccountError && err.code === "bad_username",
  );
});

test("createAccount 重名返回 duplicate_username", async () => {
  freshDir();
  await plainUser("taken-name");
  await assert.rejects(
    () => createAccount({ actor: "admin", username: "taken-name", role: "member", password: "long enough password" }),
    (err: unknown) => err instanceof AccountError && err.code === "duplicate_username",
  );
});

/* ------------------------------ updateAccount ------------------------------ */

test("updateAccount 空 patch 抛 nothing_to_change", async () => {
  freshDir();
  const id = await plainUser();
  await assert.rejects(
    () => updateAccount({ actor: "admin", id }),
    (err: unknown) => err instanceof AccountError && err.code === "nothing_to_change",
  );
});

test("updateAccount 重置密码后强制改密，并撤销该用户全部会话", async () => {
  freshDir();
  const id = await plainUser("reset-me");
  const first = await createSession({ userId: id, ttlMs: 60_000, ipHash: "abc", userAgent: "ua-1" });
  const second = await createSession({ userId: id, ttlMs: 60_000, ipHash: "def", userAgent: "ua-2" });
  assert.equal(await sessionCount(id), 2);

  const { user, changed } = await updateAccount({
    actor: "admin",
    id,
    newPassword: "brand new password",
  });
  assert.equal(user.mustChangePassword, true);
  assert.ok(changed.includes("passwordHash"));

  const stored = await findUserById(id);
  assert.ok(stored);
  assert.equal(await verifyPassword("brand new password", stored.passwordHash), true);
  assert.equal(await verifyPassword("correct horse battery", stored.passwordHash), false);

  // 密码变了，旧会话必须一起死：不然拿着旧 cookie 的人还能继续用。
  assert.equal((await findSessionByToken(first.token)).ok, false);
  assert.equal((await findSessionByToken(second.token)).ok, false);
});

test("updateAccount 降级最后一个管理员被 last_admin 挡住", async () => {
  freshDir();
  const admin = await createUser({
    username: "only-admin",
    passwordHash: await hashPassword("correct horse battery"),
    role: "admin",
    createdBy: "test",
  });
  await assert.rejects(
    () => updateAccount({ actor: "only-admin", id: admin.id, role: "member" }),
    (err: unknown) => err instanceof AccountError && err.code === "last_admin",
  );
});

/* ---------------------------- changeOwnPassword ---------------------------- */

test("changeOwnPassword 校验当前密码 / 新旧相同 / 长度", async () => {
  freshDir();
  const id = await plainUser("self-change");
  const me = await findUserById(id);
  assert.ok(me);

  await assert.rejects(
    () => changeOwnPassword({ user: me, current: "wrong password", next: "another good password" }),
    (err: unknown) => err instanceof AccountError && err.code === "wrong_password",
  );
  await assert.rejects(
    () => changeOwnPassword({ user: me, current: "correct horse battery", next: "correct horse battery" }),
    (err: unknown) => err instanceof AccountError && err.code === "same_password",
  );
  await assert.rejects(
    () => changeOwnPassword({ user: me, current: "correct horse battery", next: "short" }),
    (err: unknown) => err instanceof AccountError && err.code === "bad_password",
  );

  const updated = await changeOwnPassword({
    user: me,
    current: "correct horse battery",
    next: "totally different secret",
  });
  assert.equal(updated.mustChangePassword, false, "自己改完密码就不再是待改密状态");
  assert.equal(await verifyPassword("totally different secret", updated.passwordHash), true);
  assert.equal(await verifyPassword("correct horse battery", updated.passwordHash), false);

  // 失败也要留痕：谁在猜当前密码，审计里看得到。
  const audited = await listAudit(20);
  assert.ok(audited.some((e) => e.action === "password_failed"));
  assert.ok(audited.some((e) => e.action === "password_changed"));
});

/* ---------------------------- registerWithInvite ---------------------------- */

test("registerWithInvite 成功注册会消耗一次邀请码", async () => {
  freshDir();
  const { invite, code } = await createInvite({ note: "试用", maxUses: 2, createdBy: "admin" });

  const { user } = await registerWithInvite({ code, username: "invited-one", password: "a good long password" });
  assert.equal(user.role, "member");
  assert.equal(user.mustChangePassword, false, "自己设的密码没有初始密码要改");
  assert.equal(user.createdBy, "invite:" + invite.id);

  const stored = await findUserById(user.id);
  assert.ok(stored);
  assert.equal(await verifyPassword("a good long password", stored.passwordHash), true);
});

test("registerWithInvite 用户名被占用时不吃邀请码名额", async () => {
  freshDir();
  await plainUser("already-here");
  const { code, invite } = await createInvite({ maxUses: 1, createdBy: "admin" });

  await assert.rejects(
    () => registerWithInvite({ code, username: "already-here", password: "another long password" }),
    (err: unknown) => err instanceof AccountError && err.code === "duplicate_username",
  );

  // 关键：名额没被白吃。用户重名失败之后，同一个码还能给别人用。
  const { user } = await registerWithInvite({ code, username: "someone-else", password: "another long password" });
  assert.equal(user.username, "someone-else");
  assert.ok(invite.id);
});

test("registerWithInvite 无效邀请码 / 密码不合规都给出明确原因", async () => {
  freshDir();
  await assert.rejects(
    () => registerWithInvite({ code: "not-a-real-code-at-all", username: "nobody", password: "a good long password" }),
    (err: unknown) => err instanceof AccountError && err.code === "invite_not_found",
  );

  const { code } = await createInvite({ maxUses: 1, createdBy: "admin" });
  await assert.rejects(
    () => registerWithInvite({ code, username: "nobody", password: "short" }),
    (err: unknown) => err instanceof AccountError && err.code === "bad_password",
  );
  // 密码不合规也没吃名额：同一个码仍然可用。
  const { user } = await registerWithInvite({ code, username: "nobody", password: "a good long password" });
  assert.equal(user.username, "nobody");
});

/* -------------------------------- 删除自己 -------------------------------- */

test("deleteAccount 拒绝删除自己，删别人时审计记用户名", async () => {
  freshDir();
  const meId = await plainUser("me-self");
  const otherId = await plainUser("someone-other");

  await assert.rejects(
    () => deleteAccount({ actor: "me-self", selfId: meId, id: meId }),
    (err: unknown) => err instanceof AccountError && err.code === "self_delete",
  );
  await assert.rejects(
    () => deleteAccount({ actor: "me-self", selfId: meId, id: "no-such-id" }),
    (err: unknown) => err instanceof AccountError && err.code === "not_found",
  );

  await deleteAccount({ actor: "me-self", selfId: meId, id: otherId });
  assert.equal(await findUserByUsername("someone-other"), null);
  const audited = await listAudit(10);
  const entry = audited.find((e) => e.action === "user_deleted");
  assert.ok(entry);
  assert.equal(entry.target, "someone-other", "删号审计记用户名，不是 id");
});

/* -------------------------------- 设备管理 -------------------------------- */

test("listDevices 不泄露 tokenHash，并标出失效的会话", async () => {
  freshDir();
  const id = await plainUser("device-user");
  const live = await createSession({ userId: id, ttlMs: 60_000, ipHash: "hash-a", userAgent: "UA-Live" });
  await createSession({ userId: id, ttlMs: 60_000, ipHash: "hash-b", userAgent: "UA-Second" });

  const devices = await listDevices(id);
  assert.equal(devices.length, 2);
  assert.equal(devices.filter((d) => d.live).length, 2);
  assert.ok(devices.every((d) => !JSON.stringify(d).includes("tokenHash")));
  assert.ok(devices.every((d) => !JSON.stringify(d).includes(live.token)), "列表里不能出现 token 本身");
  assert.ok(devices.every((d) => d.userAgent && d.ipHash));
});

test("revokeDevice 不能跨用户踢人；revokeOtherDevices 保留 keep", async () => {
  freshDir();
  const a = await plainUser("user-a");
  const b = await plainUser("user-b");
  const aOne = await createSession({ userId: a, ttlMs: 60_000, ipHash: "h", userAgent: "ua" });
  const bOne = await createSession({ userId: b, ttlMs: 60_000, ipHash: "h", userAgent: "ua" });

  // 拿着 b 的会话 id 去打 a：必须打不动。
  await assert.rejects(
    () => revokeDevice({ actor: "admin", userId: a, sessionId: bOne.sessionId }),
    (err: unknown) => err instanceof AccountError && err.code === "not_found",
  );
  assert.equal(await sessionCount(b), 1, "b 的会话不该被 a 的操作影响");

  const keep = await createSession({ userId: a, ttlMs: 60_000, ipHash: "h2", userAgent: "ua2" });
  const revoked = await revokeOtherDevices({ actor: "user-a", userId: a, keepSessionId: keep.sessionId });
  assert.equal(revoked, 1);
  assert.equal((await findSessionByToken(keep.token)).ok, true, "keep 的那一枚要活着");
  assert.equal((await findSessionByToken(aOne.token)).ok, false);
});

/* -------------------------------- 错误映射 -------------------------------- */

test("accountError 把异常翻成状态码，未知异常只给通用文案", async () => {
  const bad = accountError(new AccountError("bad_password", "密码至少 10 位。"), "加上");
  assert.equal(bad.status, 400);
  assert.equal(bad.code, "bad_password");
  assert.equal(bad.message, "密码至少 10 位。");

  const missing = accountError(new AuthStoreError("not_found", "user missing"), "加上");
  assert.equal(missing.status, 404);
  assert.equal(missing.message, "用户不存在。");

  const corrupt = accountError(new AuthStoreError("store_corrupt", "bad json"), "加上");
  assert.equal(corrupt.status, 503);

  const unknown = accountError(new Error("ECONNREFUSED at /opt/probe/.data"), "创建用户失败。");
  assert.equal(unknown.status, 500);
  assert.equal(unknown.code, "internal");
  assert.equal(unknown.message, "创建用户失败。", "内部错误不抖给用户");
});

test("listAccounts 返回的每个用户都不含 passwordHash", async () => {
  freshDir();
  await plainUser("a-user");
  await createAccount({ actor: "admin", username: "b-user", role: "admin" });
  const users = await listUsers();
  assert.equal(users.length, 2);
  assert.ok(users.every((u) => !("passwordHash" in u)));
  assert.ok(users.every((u) => typeof u.sessions === "number"));
  // 顺手确认 updateUser 的被测行为没被这层包装改掉
  const id = users[0].id;
  await updateUser(id, { note: "备注一下" });
  assert.equal((await findUserById(id))?.note, "备注一下");
});
