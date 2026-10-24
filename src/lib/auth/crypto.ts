import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";

/**
 * 凭据哈希 —— 全站唯一的实现。
 *
 * 这里没有一个"可逆加密"：本站不需要把任何密码还原成明文，所以只做单向哈希。
 * 三类凭据分别用不同算法，因为它们的熵完全不同：
 *
 * 1. 用户密码（低熵，人手输入的）→ scrypt + 每用户独立随机 salt。
 *    scrypt 是内存硬的：攻击者拿到库也没法用 GPU 堆并行，只能老老实实按内存算。
 *    N=16384,r=8,p=1 在测试机上约 50-80ms/次 —— 登录能接受，撞库很难受。
 * 2. 会话 token / 邀请码（高熵，我方随机生成的）→ SHA-256。
 *    已经是 256 位随机数了，再做慢哈希只是给自己加延迟，没有任何安全收益。
 *    **但库里只存哈希**：数据库泄露 ≠ 拿到可以用的 token。
 * 3. 审计日志里的 IP → SHA-256（带固定前缀域分隔）。
 *    够用来判断"是不是同一个来源"，又不至于把访客地址长期明文留档。
 *
 * 存储格式（写进 docs/AUTH.md，脚本要对齐）：
 *   scrypt$N=16384,r=8,p=1$<salt-b64url>$<hash-b64url>
 * 参数写进字符串而不是写死在代码里：以后调高开销时，旧密码还能照原参数验证，
 * 再在登录成功时顺手升级，不会把人锁在门外。
 */

/**
 * promisify(scryptCb) 会把重载签名压成"期望 3 个参数"，带上 options 就报 TS2554。
 * 手写一层 Promise 包装：签名显式，参数也看得见。
 */
function scryptAsync(
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCb(password, salt, keylen, options, (err, derived) => {
      if (err) reject(err);
      else resolve(derived);
    });
  });
}

const N = 16_384;
const R = 8;
const P = 1;
const KEYLEN = 32;
const SALT_BYTES = 16;

/** scrypt 的 maxmem 默认是 32MB，N=16384,r=8 需要 16MB —— 留够余量。 */
const MAXMEM = 64 * 1024 * 1024;

export const PASSWORD_MIN = 10;
export const PASSWORD_MAX = 200;

function b64(buf: Buffer): string {
  return buf.toString("base64url");
}

/** 密码哈希。每次调用都换新 salt，同一个密码两次入库的字符串一定不同。 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const hash = (await scryptAsync(password.normalize("NFKC"), salt, KEYLEN, {
    N,
    r: R,
    p: P,
    maxmem: MAXMEM,
  })) as Buffer;
  return `scrypt$N=${N},r=${R},p=${P}$${b64(salt)}$${b64(hash)}`;
}

/**
 * 校验密码。解析失败、参数被改坏、算法不认识 —— 一律 false，
 * **不抛异常**：登录接口不能因为库里有条脏记录就 500。
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 4 || parts[0] !== "scrypt") return false;
  const params = parseParams(parts[1] ?? "");
  if (!params) return false;
  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(parts[2] ?? "", "base64url");
    expected = Buffer.from(parts[3] ?? "", "base64url");
  } catch {
    return false;
  }
  if (salt.length < 8 || expected.length < 16) return false;
  try {
    const actual = (await scryptAsync(password.normalize("NFKC"), salt, expected.length, {
      N: params.N,
      r: params.r,
      p: params.p,
      maxmem: MAXMEM,
    })) as Buffer;
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

function parseParams(raw: string): { N: number; r: number; p: number } | null {
  const out: Record<string, number> = {};
  for (const pair of raw.split(",")) {
    const [k, v] = pair.split("=");
    if (!k || v === undefined) return null;
    const n = Number(v);
    if (!Number.isInteger(n) || n <= 0) return null;
    out[k] = n;
  }
  const N = out.N;
  const r = out.r;
  const p = out.p;
  if (!N || !r || !p) return null;
  // 上限保护：库里被人塞了 N=2^30 的话，验证时会直接把进程的内存打爆。
  if (N > 1 << 20 || r > 32 || p > 16) return null;
  if ((N & (N - 1)) !== 0) return null; // scrypt 要求 2 的幂
  return { N, r, p };
}

/** 会话 token / 邀请码 / 找回码：32 字节随机（256 位），base64url 便于放进 URL 和 header。 */
export function newSecretToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

/** 高熵凭据入库前一律过这个。token 不需要慢哈希，只需要"存进去的不是能用的那个值"。 */
export function hashSecret(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** 审计日志里的来源地址：只留可比对的指纹，不留明文。 */
export function hashAddress(value: string): string {
  return createHash("sha256").update("probe-ip:" + value, "utf8").digest("hex").slice(0, 16);
}

/**
 * 密码策略。返回 null 表示通过，否则是给用户看的中文原因。
 * 规则刻意保守：只要长度和"不等于用户名"，其余交给用户 —— 强制符号组合
 * 只会把人逼成 Passw0rd! 这种更难记也可预测的东西。
 */
export function passwordProblem(password: string, username?: string): string | null {
  const pw = password ?? "";
  if (pw.length < PASSWORD_MIN) return `密码至少 ${PASSWORD_MIN} 位。`;
  if (pw.length > PASSWORD_MAX) return `密码最长 ${PASSWORD_MAX} 位。`;
  if (/^\s|\s$/.test(pw)) return "密码首尾不要留空格。";
  if (/\s{2,}/.test(pw)) return "密码里不要有连续空格。";
  if (username && pw.toLowerCase().includes(username.toLowerCase())) {
    return "密码里不要包含用户名。";
  }
  return null;
}

/** 用户名规范化：登录、建号、邀请都用同一份规则，避免"大小写不同算两个号"。 */
export function normalizeUsername(raw: string): string | null {
  const v = (raw ?? "").trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{2,31}$/.test(v)) return null;
  if (v.startsWith("-") || v.endsWith("-")) return null;
  return v;
}
