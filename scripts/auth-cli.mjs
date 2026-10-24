#!/usr/bin/env node
/**
 * 授权数据运维脚本 —— 服务起不来、进不去后台时的最后一条路。
 *
 * 为什么不用 --experimental-strip-types 直接 import src/lib/auth/*：
 * 那些模块用 @/ 别名和 Next 的类型，裸 Node 解析不了。这里把格式复制一份，
 * 只复制两件东西：scrypt 参数串 和 store.json 的结构。
 * 复制出来的正确性由 tests/auth.test.ts 钉住（它用本脚本生成的哈希去喂 verifyPassword）。
 *
 * 用法：
 *   node scripts/auth-cli.mjs list
 *   node scripts/auth-cli.mjs create-admin ayuan --password xxxxxxxxxx
 *   node scripts/auth-cli.mjs add-user test-01 --role member
 *   node scripts/auth-cli.mjs invite --uses 3 --hours 72 --note 给测试组
 *   node scripts/auth-cli.mjs revoke <inviteId>
 *   node scripts/auth-cli.mjs disable <username> | enable <username>
 *   node scripts/auth-cli.mjs passwd <username> --password yyyyyyyyyy
 *   node scripts/auth-cli.mjs rm-user <username>
 *
 * 注意：脚本与服务进程之间没有锁。store.json 的写入是 tmp+rename 原子的，
 * 不会写坏，但同一瞬间的两笔写会以"后写的为准"覆盖。请在服务停止或没人操作时跑。
 */
import { createHash, randomBytes, randomUUID, scrypt as scryptCb } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

const N = 16384;
const R = 8;
const P = 1;
const KEYLEN = 32;
const SALT_BYTES = 16;
const MAXMEM = 64 * 1024 * 1024;
const AUDIT_CAP = 2000;

function dataDir() {
  return process.env.PROBE_DATA_DIR?.trim() || path.join(process.cwd(), ".data");
}

function storeFile() {
  return path.join(dataDir(), "auth", "store.json");
}

function scryptAsync(password, salt, keylen, options) {
  return new Promise((resolve, reject) => {
    scryptCb(password, salt, keylen, options, (err, derived) => {
      if (err) reject(err);
      else resolve(derived);
    });
  });
}

async function hashPassword(password) {
  const salt = randomBytes(SALT_BYTES);
  const hash = await scryptAsync(password.normalize("NFKC"), salt, KEYLEN, {
    N,
    r: R,
    p: P,
    maxmem: MAXMEM,
  });
  return "scrypt$N=" + N + ",r=" + R + ",p=" + P + "$" + salt.toString("base64url") + "$" + hash.toString("base64url");
}

function hashSecret(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function newSecretToken(bytes = 32) {
  return randomBytes(bytes).toString("base64url");
}

function todayKey(at = Date.now()) {
  return new Date(at).toISOString().slice(0, 10);
}

function normalizeUsername(raw) {
  const v = String(raw ?? "").trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{2,31}$/.test(v)) return null;
  if (v.startsWith("-") || v.endsWith("-")) return null;
  return v;
}

function passwordProblem(password, username) {
  const pw = String(password ?? "");
  if (pw.length < 10) return "密码至少 10 位。";
  if (pw.length > 200) return "密码最长 200 位。";
  if (/^[ ]|[ ]$/.test(pw)) return "密码首尾不要留空格。";
  if (pw.includes("  ")) return "密码里不要有连续空格。";
  if (username && pw.toLowerCase().includes(username.toLowerCase())) return "密码里不要包含用户名。";
  return null;
}

/* ------------------------------ 读写 ------------------------------ */

async function readStore() {
  const file = storeFile();
  let raw;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return { version: 1, users: [], invites: [], sessions: [], audit: [] };
    throw err;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // 和 store.ts 一样：坏文件绝不当作空库，否则下一次写就把全站用户清了。
    fail("授权数据解析失败：" + file + "\n先备份，修好 JSON 再跑本脚本（格式见 docs/AUTH.md）。");
  }
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.users)) {
    fail("授权数据结构不对：" + file);
  }
  return {
    version: 1,
    users: parsed.users,
    invites: Array.isArray(parsed.invites) ? parsed.invites : [],
    sessions: Array.isArray(parsed.sessions) ? parsed.sessions : [],
    audit: Array.isArray(parsed.audit) ? parsed.audit : [],
  };
}

let tmpCounter = 0;

async function writeStore(s) {
  const file = storeFile();
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const now = Date.now();
  s.sessions = s.sessions.filter((x) => x.expiresAt > now);
  if (s.audit.length > AUDIT_CAP) s.audit = s.audit.slice(-AUDIT_CAP);
  const tmp = file + ".tmp-" + process.pid + "-" + ++tmpCounter;
  await fs.writeFile(tmp, JSON.stringify(s, null, 2), { encoding: "utf8", mode: 0o600 });
  await fs.rename(tmp, file);
  await fs.chmod(file, 0o600).catch(() => undefined);
}

function stamp(ts) {
  if (!ts) return "—";
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, "0");
  return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + " " +
    pad(d.getHours()) + ":" + pad(d.getMinutes());
}

function fail(message) {
  console.error("✗ " + message);
  process.exit(1);
}

/* ------------------------------ 参数解析 ------------------------------ */

function parseArgs(argv) {
  const flags = {};
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        flags[key] = true;
      } else {
        flags[key] = next;
        i += 1;
      }
    } else {
      rest.push(arg);
    }
  }
  return { flags, rest };
}

function ensureUsername(raw) {
  const name = normalizeUsername(raw);
  if (!name) fail("用户名不合法：3-32 位小写字母/数字/点/下划线，首尾不能是连字符。");
  return name;
}

async function resolvePassword(flags, username) {
  const given = typeof flags.password === "string" ? flags.password : "";
  const password = given || newSecretToken(12);
  const problem = passwordProblem(password, username);
  if (problem) fail(problem);
  return { password, generated: !given };
}

function reportPassword(username, password, generated) {
  console.log("  用户: " + username);
  if (generated) console.log("  初始密码（只显示这一次）: " + password);
  else console.log("  密码: 使用你提供的值");
}

/* -------------------------------- 命令 -------------------------------- */

async function cmdList() {
  const s = await readStore();
  console.log("数据文件: " + storeFile());
  console.log("用户 " + s.users.length + " 个 · 邀请码 " + s.invites.length + " 个 · 会话 " + s.sessions.length + " 条");
  console.log("");

  if (s.users.length) {
    console.log("用户");
    for (const u of s.users) {
      const live = s.sessions.filter((x) => x.userId === u.id && !x.revoked && x.expiresAt > Date.now()).length;
      console.log(
        "  " + u.username.padEnd(24) +
          (u.role === "admin" ? "admin" : "member").padEnd(8) +
          (u.status === "active" ? "正常" : "停用") + "  " +
          "今日 " + String(u.usage?.calls ?? 0).padStart(4) +
          " 会话 " + String(live).padStart(2) +
          " 最近登录 " + stamp(u.lastLoginAt) +
          (u.mustChangePassword ? " [待改密]" : ""),
      );
    }
    console.log("");
  }

  if (s.invites.length) {
    console.log("邀请码（明文不可恢复，库里只有哈希）");
    for (const inv of s.invites) {
      const expired = inv.expiresAt !== null && inv.expiresAt <= Date.now();
      const state = inv.revoked
        ? "已撤销"
        : expired
          ? "已过期"
          : inv.uses >= inv.maxUses
            ? "已用完"
            : "可用";
      console.log(
        "  " + inv.id + "  " +
          (inv.note || "（无备注）").slice(0, 20).padEnd(22) +
          (inv.role === "admin" ? "admin " : "user  ") +
          inv.uses + "/" + inv.maxUses + "  " +
          "过期 " + (inv.expiresAt === null ? "永久" : stamp(inv.expiresAt)) + "  " + state,
      );
    }
  }
}

async function cmdCreateUser(rest, flags, forcedRole) {
  const username = ensureUsername(rest[0] ?? flags.username);
  const s = await readStore();
  if (s.users.some((u) => u.username === username)) fail("用户名 " + username + " 已存在。");

  const role = forcedRole ?? (flags.role === "admin" ? "admin" : "member");
  const { password, generated } = await resolvePassword(flags, username);
  const now = Date.now();
  s.users.push({
    id: randomUUID(),
    username,
    role,
    status: "active",
    passwordHash: await hashPassword(password),
    createdAt: now,
    createdBy: "cli",
    updatedAt: now,
    lastLoginAt: null,
    mustChangePassword: generated,
    note: typeof flags.note === "string" ? flags.note.slice(0, 200) : "命令行创建",
    inviteId: null,
    usage: { day: todayKey(now), calls: 0 },
  });
  s.audit.push({
    at: now,
    actor: "cli",
    action: role === "admin" ? "admin_created" : "user_created",
    target: username,
    detail: "node scripts/auth-cli.mjs",
  });
  await writeStore(s);
  console.log("✓ 已创建");
  reportPassword(username, password, generated);
}

async function cmdInvite(flags) {
  const s = await readStore();
  const code = newSecretToken(20);
  const maxUses = Math.min(Math.max(Math.floor(Number(flags.uses) || 1), 1), 200);
  const hoursRaw = flags.hours === undefined ? 72 : Number(flags.hours);
  const hours = Number.isFinite(hoursRaw) && hoursRaw > 0 ? Math.min(hoursRaw, 24 * 365) : null;
  const now = Date.now();
  const row = {
    id: randomUUID(),
    codeHash: hashSecret(code),
    note: typeof flags.note === "string" ? flags.note.slice(0, 120) : "命令行生成",
    role: flags.role === "admin" ? "admin" : "member",
    maxUses,
    uses: 0,
    expiresAt: hours === null ? null : now + hours * 3600000,
    createdAt: now,
    createdBy: "cli",
    revoked: false,
    usedBy: [],
  };
  s.invites.push(row);
  s.audit.push({ at: now, actor: "cli", action: "invite_created", target: row.id, detail: "uses=" + maxUses });
  await writeStore(s);
  console.log("✓ 已生成邀请码（只显示这一次）");
  console.log("  邀请码: " + code);
  console.log("  次数: " + maxUses + " · 过期: " + (hours === null ? "永久" : hours + " 小时后"));
  console.log("  注册页: /signup");
}

async function cmdRevoke(rest) {
  const id = rest[0];
  if (!id) fail("用法: revoke <inviteId>（先用 list 看 id）");
  const s = await readStore();
  const inv = s.invites.find((x) => x.id === id);
  if (!inv) fail("邀请码不存在。");
  inv.revoked = true;
  s.audit.push({ at: Date.now(), actor: "cli", action: "invite_revoked", target: id, detail: "" });
  await writeStore(s);
  console.log("✓ 已撤销 " + id);
}

async function cmdToggle(rest, status) {
  const username = ensureUsername(rest[0]);
  const s = await readStore();
  const user = s.users.find((u) => u.username === username);
  if (!user) fail("用户不存在。");
  if (status === "disabled" && user.role === "admin") {
    const others = s.users.filter((u) => u.id !== user.id && u.role === "admin" && u.status === "active");
    if (others.length === 0) fail("这是最后一个可用管理员，停用后没人能进后台。");
  }
  user.status = status;
  user.updatedAt = Date.now();
  if (status === "disabled") {
    // 停用必须连带撤销会话，否则"停用"只是界面上好看。
    for (const sess of s.sessions) if (sess.userId === user.id) sess.revoked = true;
  }
  s.audit.push({
    at: Date.now(),
    actor: "cli",
    action: status === "disabled" ? "user_disabled" : "user_enabled",
    target: username,
    detail: "",
  });
  await writeStore(s);
  console.log("✓ " + username + " 已" + (status === "disabled" ? "停用（会话全部失效）" : "启用"));
}

async function cmdPasswd(rest, flags) {
  const username = ensureUsername(rest[0]);
  const s = await readStore();
  const user = s.users.find((u) => u.username === username);
  if (!user) fail("用户不存在。");
  const { password, generated } = await resolvePassword(flags, username);
  user.passwordHash = await hashPassword(password);
  user.mustChangePassword = generated;
  user.updatedAt = Date.now();
  for (const sess of s.sessions) if (sess.userId === user.id) sess.revoked = true;
  s.audit.push({ at: Date.now(), actor: "cli", action: "password_changed", target: username, detail: "cli" });
  await writeStore(s);
  console.log("✓ 密码已重置，该用户所有会话已失效");
  reportPassword(username, password, generated);
}

async function cmdRemove(rest) {
  const username = ensureUsername(rest[0]);
  const s = await readStore();
  const user = s.users.find((u) => u.username === username);
  if (!user) fail("用户不存在。");
  if (user.role === "admin") {
    const others = s.users.filter((u) => u.id !== user.id && u.role === "admin" && u.status === "active");
    if (others.length === 0) fail("这是最后一个可用管理员，删了就没人能进后台。");
  }
  s.users = s.users.filter((u) => u.id !== user.id);
  s.sessions = s.sessions.filter((x) => x.userId !== user.id);
  s.audit.push({ at: Date.now(), actor: "cli", action: "user_deleted", target: username, detail: "cli" });
  await writeStore(s);
  console.log("✓ 已删除 " + username);
}

async function main() {
  const [, , command, ...restArgv] = process.argv;
  const { flags, rest } = parseArgs(restArgv);

  switch (command) {
    case "list":
    case undefined:
      return cmdList();
    case "create-admin":
      return cmdCreateUser(rest, flags, "admin");
    case "add-user":
      return cmdCreateUser(rest, flags, undefined);
    case "invite":
      return cmdInvite(flags);
    case "revoke":
      return cmdRevoke(rest);
    case "disable":
      return cmdToggle(rest, "disabled");
    case "enable":
      return cmdToggle(rest, "active");
    case "passwd":
      return cmdPasswd(rest, flags);
    case "rm-user":
      return cmdRemove(rest);
    default:
      console.log("未知命令: " + command);
      console.log("可用: list | create-admin | add-user | invite | revoke | disable | enable | passwd | rm-user");
      process.exit(1);
  }
}

await main();
