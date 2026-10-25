/**
 * 反馈落盘：到阈值**归档轮转**而不是拒收。
 *
 * 上一版到 8MB 就返回 503，等于让后面所有人的意见静默消失。
 * 这里的每条断言都对着一个具体后果写，别改成只验证「函数能跑」。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { appendFeedbackLine } from "@/lib/feedback-store";

async function freshDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "probe-feedback-"));
}

async function lines(file: string): Promise<string[]> {
  const text = await readFile(file, "utf8").catch(() => "");
  return text.split("\n").filter((l) => l.trim().length > 0);
}

test("第一次写：建目录建文件，0600，不产生归档", async () => {
  const dir = await freshDir();
  const file = path.join(dir, "feedback.jsonl");
  const out = await appendFeedbackLine(file, "a\n", { maxBytes: 100, keepArchives: 3 });
  assert.equal(out.ok, true);
  assert.equal(out.ok && out.archived, null);
  assert.deepEqual(await lines(file), ["a"]);
  // 反馈里可能有联系方式，同机其他用户不该读得到。
  // Windows 不支持 POSIX 位（stat 一律回 0o666），这条只在 POSIX 上断言。
  if (process.platform !== "win32") {
    assert.equal((await stat(file)).mode & 0o777, 0o600);
  }
  await rm(dir, { recursive: true, force: true });
});

test("到阈值就归档并继续接收 —— 不返回失败", async () => {
  const dir = await freshDir();
  const file = path.join(dir, "feedback.jsonl");
  const opts = { maxBytes: 20, keepArchives: 5 };

  const first = await appendFeedbackLine(file, "0123456789\n", opts);
  assert.equal(first.ok && first.archived, null);
  // 10 字节 + 换行，还不到 20，所以这一条照常追加。
  const second = await appendFeedbackLine(file, "abcdefghij\n", opts);
  assert.equal(second.ok && second.archived, null);
  // 现在 20 字节 ≥ 阈值：下一条进来先归档旧的，再写新的。
  const third = await appendFeedbackLine(file, "NEW\n", opts);
  assert.equal(third.ok, true);
  assert.ok(third.ok && third.archived, "应当返回归档文件名");

  // 用户提交的那条留在主文件里，之前的留在 archive 里 —— 一条都不丢。
  assert.deepEqual(await lines(file), ["NEW"]);
  const archived = await lines(path.join(dir, "archive", (third.ok && third.archived) || ""));
  assert.deepEqual(archived, ["0123456789", "abcdefghij"]);
  await rm(dir, { recursive: true, force: true });
});

test("归档只留最近 keepArchives 份，磁盘占用有上界", async () => {
  const dir = await freshDir();
  const file = path.join(dir, "feedback.jsonl");
  const opts = { maxBytes: 4, keepArchives: 2 };
  // 每写一条都超过 4 字节，于是每条都会触发一次轮转。
  for (let i = 0; i < 6; i += 1) {
    const out = await appendFeedbackLine(file, "line-" + i + "\n", {
      ...opts,
      // 固定时间戳会让归档撞名，这里故意用不同秒，验证的是保留份数而不是撞名。
      now: new Date(2026, 0, 1, 0, 0, i),
    });
    assert.equal(out.ok, true);
  }
  const names = (await readdir(path.join(dir, "archive"))).sort();
  assert.equal(names.length, 2);
  await rm(dir, { recursive: true, force: true });
});

test("并发 20 条全部落盘，且不会因为并发各自看到「还没满」而丢", async () => {
  const dir = await freshDir();
  const file = path.join(dir, "feedback.jsonl");
  const opts = { maxBytes: 1_000_000, keepArchives: 5 };
  await Promise.all(
    Array.from({ length: 20 }, (_, i) => appendFeedbackLine(file, "c" + i + "\n", opts)),
  );
  const got = await lines(file);
  assert.equal(got.length, 20);
  await rm(dir, { recursive: true, force: true });
});
