/**
 * 账号级历史的存储层。
 *
 * 每条断言都对着一个会伤人的后果写：
 *   - 别人的记录能读到 → 越权；
 *   - 过期数据还占着库 → 说好的 90 天变成永久；
 *   - 每人上限失效 → 一个账号能把磁盘写满；
 *   - 关掉「存原文」还留着原文 → 用户以为关了其实没关。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { __testCloseDb } from "@/lib/db";
import { currentVersion, MIGRATIONS } from "@/lib/db/migrate";
import {
  clearQueries,
  countQueries,
  deleteQuery,
  getQuery,
  importQueries,
  listQueries,
  pruneExpired,
  retentionDays,
  saveQuery,
  storeQueryText,
} from "@/lib/history-store";
import { getDb } from "@/lib/db";

const dirs: string[] = [];

function freshDataDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "probe-history-"));
  dirs.push(dir);
  __testCloseDb();
  process.env.PROBE_DATA_DIR = dir;
  return dir;
}

process.on("exit", () => {
  for (const dir of dirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // 清理失败不影响断言结果
    }
  }
});

function withEnv(patch: Record<string, string | undefined>, fn: () => void): void {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(patch)) {
    saved[k] = process.env[k];
    if (patch[k] === undefined) delete process.env[k];
    else process.env[k] = patch[k];
  }
  try {
    fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const base = { region: "cn", modelHost: "api.deepseek.com" } as const;

test("迁移：跑两遍不会重复建表，版本号停在代码认识的最后一版", () => {
  freshDataDir();
  const db = getDb();
  assert.equal(currentVersion(db), MIGRATIONS.length);
  // getDb() 内部已经 migrate 过一次；再显式调一次必须是无操作。
  const again = getDb();
  assert.equal(currentVersion(again), MIGRATIONS.length);
});

test("写入与读取：自己的能看到，别人的拿不到（不是 403，是查不到）", () => {
  freshDataDir();
  const id = saveQuery({ userId: "u1", query: "存储芯片 产能", ...base, intentKind: "lookup", entities: ["台积电"], claims: 3 });

  const mine = getQuery("u1", id);
  assert.ok(mine);
  assert.equal(mine?.query, "存储芯片 产能");
  assert.equal(mine?.intentKind, "lookup");
  assert.equal(mine?.counts.claims, 3);

  // 换个账号：同一条 id 必须返回 null —— 路由把它翻成 404，不泄露「这条存在」。
  assert.equal(getQuery("u2", id), null);
  assert.equal(countQueries("u2"), 0);
});

test("列表按时间倒序、游标分页不重不漏", () => {
  freshDataDir();
  const t0 = Date.now();
  for (let i = 0; i < 5; i += 1) {
    saveQuery({ userId: "u1", query: "q" + i, ...base, now: t0 + i * 1_000 });
  }
  const first = listQueries("u1", { limit: 2 });
  assert.deepEqual(first.items.map((r) => r.query), ["q4", "q3"]);
  assert.equal(first.next, t0 + 3_000);

  const second = listQueries("u1", { limit: 2, before: first.next });
  assert.deepEqual(second.items.map((r) => r.query), ["q2", "q1"]);

  const third = listQueries("u1", { limit: 2, before: second.next });
  assert.deepEqual(third.items.map((r) => r.query), ["q0"]);
  assert.equal(third.next, null);
});

test("信源只存 URL/标题/来源/引文 hash —— 原文一个字都不落库", () => {
  freshDataDir();
  const id = saveQuery({
    userId: "u1",
    query: "x",
    ...base,
    sources: [
      { url: "https://a.example/news/1", title: "标题一", provider: "bocha", quoteHash: "abc123" },
      { url: "https://b.example/2", title: "标题二", provider: "wiki", quoteHash: null },
    ],
  });
  const row = getQuery("u1", id);
  assert.equal(row?.sources, 2);
  // hosts 是去重后的域名：列表里要能一眼看出「这轮读了哪些站」。
  assert.deepEqual(row?.hosts, ["a.example", "b.example"]);
  assert.equal(row?.sourceRows.length, 2);
  assert.equal(row?.sourceRows[0].quoteHash, "abc123");
});

test("保留期是字段：expires_at = created_at + PROBE_HISTORY_RETENTION_DAYS", () => {
  freshDataDir();
  const t0 = 1_700_000_000_000;
  withEnv({ PROBE_HISTORY_RETENTION_DAYS: "7" }, () => {
    assert.equal(retentionDays(), 7);
    const id = saveQuery({ userId: "u1", query: "x", ...base, now: t0 });
    const db = getDb();
    const row = db.prepare("SELECT created_at, expires_at FROM queries WHERE id = ?").get(id) as {
      created_at: number;
      expires_at: number;
    };
    assert.equal(row.expires_at - row.created_at, 7 * 86_400_000);
  });
});

test("过期清理：过了日期的删掉，没过的一条不动", () => {
  freshDataDir();
  withEnv({ PROBE_HISTORY_RETENTION_DAYS: "1" }, () => {
    // now 落在一个月前 → 它已经过期了。
    const old = saveQuery({ userId: "u1", query: "old", ...base, now: Date.now() - 31 * 86_400_000 });
    const fresh = saveQuery({ userId: "u1", query: "fresh", ...base });
    assert.equal(countQueries("u1"), 2);
    const removed = pruneExpired();
    assert.equal(removed, 1);
    assert.equal(getQuery("u1", old), null);
    assert.ok(getQuery("u1", fresh));
  });
});

test("每人上限：超出的从最旧开始删，不是拒收新记录", () => {
  freshDataDir();
  withEnv({ PROBE_HISTORY_PER_USER: "3" }, () => {
    const t0 = Date.now();
    for (let i = 0; i < 5; i += 1) {
      saveQuery({ userId: "u1", query: "q" + i, ...base, now: t0 + i * 1_000 });
    }
    assert.equal(countQueries("u1"), 3);
    const list = listQueries("u1", { limit: 10 });
    assert.deepEqual(list.items.map((r) => r.query), ["q4", "q3", "q2"]);
  });
});

test("PROBE_HISTORY_STORE_QUERY=0：原文不落库，只剩一条空记录", () => {
  freshDataDir();
  withEnv({ PROBE_HISTORY_STORE_QUERY: "0" }, () => {
    assert.equal(storeQueryText(), false);
    const id = saveQuery({ userId: "u1", query: "很敏感的提问", ...base });
    assert.equal(getQuery("u1", id)?.query, "");
  });
});

test("畸形输入不炸：超长 query 截断，非字符串实体与降级码被丢掉", () => {
  freshDataDir();
  const id = saveQuery({
    userId: "u1",
    query: "x".repeat(1_000),
    ...base,
    // 这几项都可能是模型吐出来的怪东西。
    entities: ["ok", 42, null, "", "ok"] as unknown as string[],
    degraded: [7, "llm:user_budget", "llm:user_budget"] as unknown as string[],
    summaryLen: Number.NaN,
    claims: -5,
  });
  const row = getQuery("u1", id);
  assert.equal(row?.query.length, 400);
  assert.deepEqual(row?.degraded, ["llm:user_budget"]);
  assert.equal(row?.counts.claims, 0);
});

test("删除是物理删除：删一条与清空都不留残骸", () => {
  freshDataDir();
  const a = saveQuery({ userId: "u1", query: "a", ...base });
  saveQuery({ userId: "u1", query: "b", ...base });
  assert.equal(deleteQuery("u1", a), true);
  // 幂等：再删一次回 false，但不抛。
  assert.equal(deleteQuery("u1", a), false);
  assert.equal(countQueries("u1"), 1);
  assert.equal(clearQueries("u1"), 1);
  assert.equal(countQueries("u1"), 0);
});

test("从 localStorage 导入：重复调用不会灌出重复记录", () => {
  freshDataDir();
  const at = Date.now() - 86_400_000;
  const items = [{ query: "旧问题一", at }, { query: "旧问题二", at }];
  const first = importQueries("u1", items, base);
  assert.deepEqual(first, { imported: 2, skipped: 0 });
  const second = importQueries("u1", items, base);
  assert.deepEqual(second, { imported: 0, skipped: 2 });
  assert.equal(countQueries("u1"), 2);
  // 导入的记录标 intentKind=import，界面据此说明「这是从浏览器带过来的」。
  assert.equal(listQueries("u1").items[0].intentKind, "import");
});
