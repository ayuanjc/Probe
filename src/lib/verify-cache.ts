import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * 缓存：docId → 一趟核验的全部中间结果。
 *
 * 写盘方式照抄 heat-history.ts（写 .tmp 再 rename）—— 核验过程可能被客户端断开掐掉，
 * 直接写目标文件会留下半个 JSON，下次读它的人拿到的是 JSON.parse 异常。
 *
 * 三条纪律：
 *   1. 只缓存内容，不缓存 key、不缓存 prompt。缓存目录可能被打包带走。
 *   2. partial 为 true 的文件是「可以接着跑」的，不是损坏文件。
 *   3. 读失败一律当没有缓存，不把异常抛给调用方 —— 缓存是加速，不是依赖。
 */

export const CACHE_DIR = path.join(process.cwd(), ".cache", "verify");
export const CACHE_VERSION = 1;

export type CachedRun = {
  version: number;
  docId: string;
  title: string;
  chars: number;
  createdAt: string;
  updatedAt: string;
  segments: { idx: number; charStart: number; charEnd: number; text: string }[];
  claims: unknown[];
  evidences: unknown[];
  verdicts: unknown[];
  scores: unknown | null;
  /** true = 这次没跑完（断开 / 预算顶到），可以 resume。 */
  partial: boolean;
  notes: string[];
};

function fileOf(docId: string): string {
  // docId 是 sha1 前 16 位十六进制，天然安全；仍然兜一层，防将来换成别的 id 方案。
  const safe = docId.replace(/[^a-z0-9]/gi, "").slice(0, 32);
  return path.join(CACHE_DIR, safe + ".json");
}

export async function readCache(docId: string): Promise<CachedRun | null> {
  try {
    const raw = await readFile(fileOf(docId), "utf8");
    const parsed = JSON.parse(raw) as CachedRun;
    if (!parsed || parsed.version !== CACHE_VERSION || parsed.docId !== docId) return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function writeCache(run: CachedRun): Promise<boolean> {
  const target = fileOf(run.docId);
  const tmp = target + ".tmp-" + process.pid + "-" + Date.now();
  try {
    await mkdir(CACHE_DIR, { recursive: true });
    await writeFile(tmp, JSON.stringify(run), "utf8");
    await rename(tmp, target);
    return true;
  } catch {
    // 写不进去不算失败：核验结果已经在 SSE 里发出去了，缓存只是下次的加速。
    return false;
  }
}
