import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * 反馈落盘（一行一条 JSONL）+ 到达上限后**归档轮转**，而不是拒收。
 *
 * 上一版的行为是「文件超过 8MB 就返回 503 停止接收」。问题不在上限本身，
 * 在后果：反馈的价值是「别丢」，而守着上限拒收等于让后面所有人的意见
 * 静默消失 —— 提反馈的人只会看到一句"存储已满"，然后走掉。
 *
 * 现在的口径：
 *   - 达到阈值 → 把当前文件改名进 archive/feedback-YYYYMMDD-HHmmss.jsonl，
 *     新文件从零开始，请求照常成功；
 *   - 只保留最近 keepArchives 份归档（多出来的按时间删最旧），
 *     所以磁盘占用有上界，运维也不需要记得手动清理；
 *   - 「看一眼大小 + 归档 + 追加」全在同一临界区里 —— 进程内并发不能各自
 *     看到"还没满"再一起写（多实例部署仍需文件锁，本服务是单进程 unit）。
 */

export type AppendOutcome =
  | { ok: true; archived: string | null }
  | { ok: false; reason: string };

let writeQueue: Promise<unknown> = Promise.resolve();

function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = writeQueue.then(fn, fn);
  writeQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function stamp(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    String(now.getFullYear()) +
    pad(now.getMonth() + 1) +
    pad(now.getDate()) +
    "-" +
    pad(now.getHours()) +
    pad(now.getMinutes()) +
    pad(now.getSeconds())
  );
}

const ARCHIVE_RE = /^feedback-\d{8}-\d{6}(-\d+)?\.jsonl$/;

/** 归档目录里按时间排序、只留最近 keep 份。返回被删掉的文件名。 */
async function pruneArchives(dir: string, keep: number): Promise<string[]> {
  const names = (await fs.readdir(dir).catch(() => [] as string[])).filter((n) => ARCHIVE_RE.test(n)).sort();
  const extra = keep >= 0 ? names.slice(0, Math.max(0, names.length - keep)) : [];
  for (const name of extra) {
    await fs.rm(path.join(dir, name), { force: true }).catch(() => undefined);
  }
  return extra;
}

export async function appendFeedbackLine(
  file: string,
  line: string,
  opts: { maxBytes: number; keepArchives: number; now?: Date },
): Promise<AppendOutcome> {
  const dir = path.dirname(file);
  const archiveDir = path.join(dir, "archive");
  const base = path.basename(file, ".jsonl");

  return withLock(async () => {
    let archived: string | null = null;
    const stat = await fs.stat(file).catch(() => null);
    if (stat && stat.size >= opts.maxBytes) {
      await fs.mkdir(archiveDir, { recursive: true, mode: 0o700 });
      // 同一秒内归档两次会撞名：加 -2/-3 后缀，别覆盖掉上一份（永远不丢数据）。
      const at = opts.now ?? new Date();
      let name = base + "-" + stamp(at) + ".jsonl";
      for (let i = 2; i < 100; i += 1) {
        const exists = await fs
          .stat(path.join(archiveDir, name))
          .then(() => true)
          .catch(() => false);
        if (!exists) break;
        name = base + "-" + stamp(at) + "-" + i + ".jsonl";
      }
      await fs.rename(file, path.join(archiveDir, name));
      archived = name;
      await pruneArchives(archiveDir, opts.keepArchives);
    }

    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    // mode 只在新建时生效：反馈里可能有联系方式，别让同机其他用户读到。
    await fs.appendFile(file, line, { encoding: "utf8", mode: 0o600 });
    return { ok: true as const, archived };
  }).catch((err: unknown) => ({
    ok: false as const,
    reason: err instanceof Error ? err.message : String(err),
  }));
}

/** 仅供测试：把临界区排空，避免用例之间互相等待。 */
export async function __testDrainFeedbackQueue(): Promise<void> {
  await writeQueue.catch(() => undefined);
}
