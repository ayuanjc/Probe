/**
 * 用户协议的「同意」凭据 —— 纯数据与解析，不带任何 node 依赖。
 *
 * 为什么要拆出 consent-log.ts：这个文件会被客户端组件 import（弹层要读常量、
 * 要拼 cookie 值），一旦在这里 import node:fs，整个组件就会被打进浏览器包并构建失败。
 *
 * 凭据的形状刻意做成「版本.时间戳」：
 *   - 带版本，是因为协议一改，旧同意必须失效 —— 否则你改完免责条款，老用户仍是
 *     「同意过」的状态，这在新条款下是站不住的；
 *   - 带时间，是因为举证时要说清「什么时候同意的」。Cookie 本身有 Max-Age，
 *     但用户可以用脚本续期，服务端日志里的那条记录才是真凭据。
 *
 * 版本号**不写在这里**：它是协议正文的哈希（见 lib/legal/version.ts），由服务端算好、
 * 作为参数传进来。手写版本号会忘，忘了就等于新条款对老用户不生效。这个文件只负责
 * 「怎么存、怎么解析、怎么判有效」，不负责「版本号是多少」。
 */

/** 确认按钮最早可用的时刻。 */
export const CONSENT_MIN_READ_MS = 10_000;

/** 同意有效期：一年。到期后重新弹一次，不是每次都弹。 */
export const CONSENT_MAX_AGE_SECONDS = 365 * 24 * 60 * 60;

export const CONSENT_COOKIE = "probe_consent";

export type ConsentRecord = {
  version: string;
  /** 用户点击确认时的时间（毫秒）。服务端只做合理性校验，不作为事实时间。 */
  at: number;
};

/** 写进 cookie 的值：<版本>.<毫秒时间戳> */
export function consentCookieValue(version: string, at: number = Date.now()): string {
  return version + "." + Math.floor(at);
}

/** cookie 名的部署前缀：挂在 /probe 下时 cookie 也必须限定在该路径。 */
export function consentCookiePath(): string {
  const raw = (process.env.NEXT_PUBLIC_PROBE_BASE_PATH ?? "").trim();
  const trimmed = raw.replace(/\/+$/, "");
  return trimmed || "/";
}

/**
 * 解析 cookie。任何异常形状一律当作「没有同意」—— 宁可多弹一次，
 * 也不要因为一个脏 cookie 让某个人在没同意新条款的情况下继续用。
 */
export function parseConsentCookie(raw: string | null | undefined): ConsentRecord | null {
  if (!raw) return null;
  const text = raw.trim();
  if (text.length === 0 || text.length > 64) return null;
  const cut = text.lastIndexOf(".");
  if (cut <= 0) return null;
  const version = text.slice(0, cut);
  const stamp = text.slice(cut + 1);
  if (!/^[0-9A-Za-z.-]{1,40}$/.test(version)) return null;
  if (!/^[0-9]{1,16}$/.test(stamp)) return null;
  const at = Number(stamp);
  // 2020-01-01 之前或 2100 年之后的时间戳明显是伪造/损坏的
  if (!Number.isFinite(at) || at < 1_577_836_800_000 || at > 4_102_444_800_000) return null;
  return { version, at };
}

/** 同意是否仍然对**当前**协议版本有效。版本号由调用方给（服务端算的哈希）。 */
export function consentIsCurrent(record: ConsentRecord | null, version: string): boolean {
  return record !== null && record.version === version;
}
