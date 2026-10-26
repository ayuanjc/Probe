/**
 * 实体追踪（公开时间线的数据层）。
 *
 * 与 watch-store 的测试分工：那边钉「私人、按人、要登录」，
 * 这边钉「公开、匿名、不能反推谁看过」。
 *
 * 每条断言对着一个会伤人的后果：
 *   - 歧义实体（苹果 = 水果）进时间线 → 我们开始编故事；
 *   - 同一条 URL 重复计入 → 时间线上「五家报道」其实是一家被转了五次；
 *   - 每实体上限失效 → 一条时间线变成电话簿；
 *   - 表里出现 user_id → 公开页从此能反查谁在关注什么；
 *   - 保留期失效 → 一个季度前的旧闻被当成「刚刚」。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { getDb, __testCloseDb } from "@/lib/db";
import {
  __testResetEntities,
  dictEntities,
  entitiesInTitle,
  entityEnabled,
  entityStats,
  entitySummary,
  listEntityHits,
  pruneEntityHits,
  recordEntityHits,
  topEntities,
} from "@/lib/entity-track";

const dirs: string[] = [];

function freshDataDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "probe-entity-"));
  dirs.push(dir);
  __testCloseDb();
  process.env.PROBE_DATA_DIR = dir;
  __testResetEntities();
  return dir;
}

process.on("exit", () => {
  for (const dir of dirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // 清理失败不影响断言
    }
  }
});

const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 9, 26, 0, 0, 0);

test("词典实体：键取中文展示名，别名都进匹配集", () => {
  const dict = dictEntities();
  const tsmc = dict.find((e) => e.key === "台积电");
  assert.ok(tsmc, "词典应有台积电");
  assert.equal(tsmc!.name, "台积电");
  assert.equal(tsmc!.kind, "org");
  assert.ok(tsmc!.aliases.some((a) => a.toLowerCase() === "tsmc"));
  // 键唯一：同一家公司不会在时间线上裂成两条
  assert.equal(new Set(dict.map((e) => e.key)).size, dict.length);
});

test("标题命中：中文与英文别名都算，歧义词没有上下文不算", () => {
  assert.deepEqual(entitiesInTitle("台积电 3nm 产能满载").map((e) => e.key), ["台积电"]);
  assert.deepEqual(entitiesInTitle("TSMC beats estimates").map((e) => e.key), ["台积电"]);
  // 苹果是歧义词：只说「苹果价格」不能当成苹果公司
  assert.deepEqual(entitiesInTitle("苹果价格今年涨了两成"), []);
  assert.deepEqual(entitiesInTitle("苹果发布 iPhone 17").map((e) => e.key), ["苹果公司"]);
  assert.deepEqual(entitiesInTitle(""), []);
});

test("落库：一条 story 命中多个实体各记一条，同 URL 只记一次", () => {
  freshDataDir();
  const story = { title: "英伟达 与 台积电 联手 扩产", url: "https://www.ithome.com/1", host: "www.ithome.com", provider: "ithome" };
  const first = recordEntityHits([story], T0);
  assert.equal(first.inserted, 2, "两个实体各一条");
  assert.equal(first.matched, 2);
  const again = recordEntityHits([story], T0 + HOUR);
  assert.equal(again.inserted, 0, "同一 URL 不重复计入");
  assert.equal(again.matched, 2, "matched 是去重前的命中数，仍然要说实话");
});

test("空标题 / 空链接被丢掉，不占库", () => {
  freshDataDir();
  const res = recordEntityHits([
    { title: "", url: "https://a.com/1" },
    { title: "台积电 扩产", url: "" },
  ], T0);
  assert.equal(res.inserted, 0);
  assert.equal(entityStats().hits, 0);
});

test("每个实体有上限，超出丢最旧的", () => {
  freshDataDir();
  process.env.PROBE_ENTITY_HITS_PER_KEY = "2";
  for (let i = 0; i < 4; i += 1) {
    recordEntityHits([{ title: "台积电 扩产 第" + i + "天", url: "https://a.com/" + i }], T0 + i * HOUR);
  }
  const page = listEntityHits("台积电", { limit: 10 });
  assert.equal(page.items.length, 2, "上限 2 条");
  assert.deepEqual(page.items.map((h) => h.url), ["https://a.com/3", "https://a.com/2"]);
  delete process.env.PROBE_ENTITY_HITS_PER_KEY;
});

test("保留期：超期命中被 prune 删掉", () => {
  freshDataDir();
  recordEntityHits([{ title: "台积电 旧闻", url: "https://a.com/old" }], T0 - 40 * 24 * HOUR);
  recordEntityHits([{ title: "台积电 新消息", url: "https://a.com/new" }], T0);
  const removed = pruneEntityHits(100, T0);
  assert.equal(removed, 1);
  const page = listEntityHits("台积电", { limit: 10 });
  assert.deepEqual(page.items.map((h) => h.url), ["https://a.com/new"]);
});

test("游标分页：before 取上一页最后一条的 at", () => {
  freshDataDir();
  for (let i = 0; i < 5; i += 1) {
    recordEntityHits([{ title: "台积电 消息 " + i, url: "https://a.com/" + i }], T0 + i * HOUR);
  }
  const p1 = listEntityHits("台积电", { limit: 2 });
  assert.equal(p1.items.length, 2);
  assert.ok(p1.next !== null);
  const p2 = listEntityHits("台积电", { limit: 2, before: p1.next! });
  assert.equal(p2.items.length, 2);
  // 两页不重叠
  const ids = new Set([...p1.items, ...p2.items].map((h) => h.id));
  assert.equal(ids.size, 4);
});

test("概览：总数 / 24 小时 / 7 天 / 来源分布", () => {
  freshDataDir();
  recordEntityHits([{ title: "台积电 近闻", url: "https://a.com/1", provider: "ithome" }], T0 - 2 * HOUR);
  recordEntityHits([{ title: "台积电 三天前", url: "https://a.com/2", provider: "sspai" }], T0 - 3 * 24 * HOUR);
  recordEntityHits([{ title: "台积电 十天前", url: "https://a.com/3", provider: "ithome" }], T0 - 10 * 24 * HOUR);
  const s = entitySummary("台积电", T0);
  assert.equal(s.total, 3);
  assert.equal(s.last24h, 1);
  assert.equal(s.last7d, 2);
  assert.equal(s.name, "台积电");
  assert.equal(s.sources[0].provider, "ithome");
  assert.equal(s.sources[0].n, 2);
  // 不存在的实体不抛错：页面要能显示空态
  const empty = entitySummary("不存在的公司", T0);
  assert.equal(empty.total, 0);
  assert.equal(empty.name, "不存在的公司");
});

test("排行：按提及数倒序，days 生效", () => {
  freshDataDir();
  recordEntityHits([{ title: "台积电 扩产", url: "https://a.com/1" }], T0 - 1 * HOUR);
  recordEntityHits([{ title: "台积电 再扩产", url: "https://a.com/2" }], T0 - 2 * HOUR);
  recordEntityHits([{ title: "华为 发布会", url: "https://a.com/3" }], T0 - 1 * HOUR);
  const top = topEntities({ days: 7, limit: 10 }, T0);
  assert.equal(top[0].key, "台积电");
  assert.equal(top[0].total, 2);
  assert.equal(top[0].last24h, 2);
  // 30 天前的命中被 days=7 排除
  recordEntityHits([{ title: "比亚迪 出海", url: "https://a.com/4" }], T0 - 30 * 24 * HOUR);
  assert.equal(topEntities({ days: 7, limit: 10 }, T0).some((e) => e.key === "比亚迪"), false);
  assert.equal(topEntities({ days: 0, limit: 10 }, T0).some((e) => e.key === "比亚迪"), true);
});

test("开关：PROBE_ENTITY_SERVER=0 时关闭（cron 与页面都靠它）", () => {
  const old = process.env.PROBE_ENTITY_SERVER;
  process.env.PROBE_ENTITY_SERVER = "0";
  assert.equal(entityEnabled(), false);
  process.env.PROBE_ENTITY_SERVER = "1";
  assert.equal(entityEnabled(), true);
  if (old === undefined) delete process.env.PROBE_ENTITY_SERVER;
  else process.env.PROBE_ENTITY_SERVER = old;
});

test("表里没有 user_id：公开时间线永远不能反推谁看过", () => {
  freshDataDir();
  recordEntityHits([{ title: "台积电 扩产", url: "https://a.com/1" }], T0);
  const cols = getDb().prepare("PRAGMA table_info(entity_hits)").all() as Record<string, unknown>[];
  const names = cols.map((c) => String(c.name));
  assert.ok(names.includes("entity_key"));
  for (const banned of ["user_id", "username", "email", "session_id"]) {
    assert.equal(names.includes(banned), false, "entity_hits 不该有 " + banned);
  }
});

test("时间线按「发布时刻」排，不按「我们抓到的时刻」排", () => {
  freshDataDir();
  // 同一轮 cron 抓到的两条：一条是 3 天前的旧闻，一条是 10 分钟前的新消息。
  // 落库时间戳（now）完全相同 —— 如果按 created_at 排，旧闻会排在新消息前面。
  const oldIso = new Date(T0 - 72 * HOUR).toISOString();
  const newIso = new Date(T0 - 10 * 60_000).toISOString();
  recordEntityHits(
    [
      { title: "台积电 旧闻", url: "https://a.com/old", seenAt: oldIso },
      { title: "台积电 新消息", url: "https://a.com/new", seenAt: newIso },
    ],
    T0,
  );
  const page = listEntityHits("台积电", { limit: 10 });
  assert.equal(page.items[0].title, "台积电 新消息");
  assert.equal(page.items[1].title, "台积电 旧闻");
  assert.equal(page.items[0].at, Date.parse(newIso));
  // 「24 小时」必须按事件时间算：三天前的旧闻今天才被我们看见，也不算今天的事。
  const s = entitySummary("台积电", T0);
  assert.equal(s.total, 2);
  assert.equal(s.last24h, 1);
  assert.equal(s.last7d, 2);
  assert.equal(s.firstAt, Date.parse(oldIso));
});

test("上游时间脏了就退回抓取时间，不能让一条脏数据把时间线拉到 1969 年", () => {
  freshDataDir();
  recordEntityHits(
    [
      { title: "台积电 时区写错", url: "https://a.com/future", seenAt: new Date(T0 + 48 * HOUR).toISOString() },
      { title: "台积电 空时间", url: "https://a.com/none", seenAt: null },
      { title: "台积电 乱码时间", url: "https://a.com/junk", seenAt: "昨天下午" },
    ],
    T0,
  );
  for (const hit of listEntityHits("台积电", { limit: 10 }).items) {
    assert.equal(hit.at, T0, hit.title + " 的时间应退回抓取时刻");
  }
});

test("days 窗口按发布时刻算：旧闻今天才被抓到，不进 7 天榜", () => {
  freshDataDir();
  recordEntityHits(
    [{ title: "台积电 旧闻", url: "https://a.com/old", seenAt: new Date(T0 - 30 * 24 * HOUR).toISOString() }],
    T0,
  );
  assert.equal(topEntities({ days: 7, limit: 10 }, T0).some((e) => e.key === "台积电"), false);
  assert.equal(topEntities({ days: 0, limit: 10 }, T0).some((e) => e.key === "台积电"), true);
});

test("实体展示名用读者认的那个：词典里 zh[0] 写成英文时不要用音译", () => {
  const all = dictEntities();
  const openai = all.find((e) => e.key === "openai");
  assert.ok(openai, "OpenAI 应该在实体表里");
  assert.equal(openai.name, "OpenAI");
  // 音译仍然作为别名参与匹配，只是不挂在门上当招牌。
  assert.ok(openai.aliases.some((a) => a === "欧朋艾"));
  assert.equal(all.find((e) => e.key === "anthropic")?.name, "Anthropic");
  // 中文名本来就是 zh[0] 的，保持不变。
  assert.equal(all.find((e) => e.key === "台积电")?.name, "台积电");
});

test("泛词不当实体：\"保暖与安全\"不该变成一条安全情报", () => {
  assert.equal(entitiesInTitle("电动自行车保暖与安全如何两全").length, 0);
  assert.ok(!dictEntities().some((e) => e.key === "安全"));
});
