/**
 * 同意记录的服务端落盘。
 *
 * 为什么必须存：只把同意写进用户浏览器里的 cookie，等于让用户自己举证自己同意过。
 * 真有争议时，「某时刻某地址指纹确认了 vN 版协议」这条服务端记录才是能拿出来的东西。
 *
 * 记录的是**地址指纹**而不是明文 IP（跟安全日志同一口径），一列 SHA-256 前缀只够
 * 区分设备/网络，不足以还原到人 —— 隐私政策里也是这么写的，两处必须一致。
 */

import { appendFile, mkdir, rename, stat } from "node:fs/promises";
import path from "node:path";
import { hashAddress } from "@/lib/auth/crypto";

/** 单个文件上限 8MB（约两万条），超了滚成 .1 —— 只留一轮，够用且不涨磁盘。 */
const MAX_LOG_BYTES = 8 * 1024 * 1024;

export type ConsentWrite = {
  version: string;
  /** 客户端自报的浏览时长（毫秒）。只用于识别「明显没读」的脚本请求。 */
  msRead: number;
  ip?: string;
  userAgent?: string;
};

function dataDir(): string {
  const raw = (process.env.PROBE_DATA_DIR ?? "").trim();
  return raw.length > 0 ? raw : path.join(process.cwd(), ".data");
}

export function consentLogFile(): string {
  return path.join(dataDir(), "consent", "consent.log");
}

/** 追加一条记录。失败只 warn —— 记不上同意日志不该拦住用户使用。 */
export async function recordConsent(write: ConsentWrite): Promise<void> {
  const file = consentLogFile();
  const line =
    JSON.stringify({
      at: new Date().toISOString(),
      version: write.version,
      msRead: Math.max(0, Math.round(write.msRead)),
      ip: write.ip ? hashAddress(write.ip) : null,
      ua: (write.userAgent ?? "").slice(0, 180) || null,
    }) + "\n";
  try {
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    try {
      const info = await stat(file);
      if (info.size > MAX_LOG_BYTES) await rename(file, file + ".1");
    } catch {
      /* 首次写入时 stat 会失败，正常 */
    }
    await appendFile(file, line, { mode: 0o600 });
  } catch (err) {
    console.warn("[consent] 写同意记录失败", err);
  }
}
