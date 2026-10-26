/**
 * 关注实体与命中（P1）。
 *
 * 每条断言对着一个会伤人的后果：
 *   - 别人的命中能读到 → 越权；
 *   - 同一条新闻重复计入 → 未读数变成噪音，用户第一次就关掉它；
 *   - 歧义词（苹果 = 水果）被推出去 → 我们开始造谣；
 *   - 上限失效 → 一次热榜把库写满；
 *   - 取消关注还留着命中 → 我们记得他不该被记住的东西。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { __testCloseDb } from "@/lib/db";
import { saveQuery } from "@/lib/history-store";
import { matchStory, watchKeyOf } from "@/lib/watch-match";
import {
  addWatch,
  clearWatches,
  countUnread,
  listHits,
  listWatches,
  markAllRead,
  markRead,
  matchHits,
  pruneHits,
  recordHits,
  removeWatch,
  suggestWatches,
  watchEnabled,
  watchStats,
  type StoryLite,
} from "@/lib/watch-store";

const dirs: string[] = [];

function freshDataDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "probe-watch-"));
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
      // 清理失败不影响断言
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
    for (const k of Object.keys(patch)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

const DAY = 86_400_000;

function story(title: string, url: string, points = 10): StoryLite {
  return { title, url, host: "news.ycombinator.com", provider: "hn", points, seenAt: "2026-10-01T00:00:00.000Z" };
}

test("关注名归一：中英别名是同一个关注", () => {
  const a = watchKeyOf("TSMC");
  const b = watchKeyOf("台积电");
  assert.ok(a && b);
  assert.equal(a.name, "台积电", "展示名取中文别名");
  assert.equal(a.key, b.key, "TSMC 与 台积电 必须落到同一个键");
  assert.equal(a.kind, "org");
  assert.ok(a.aliases.some((x) => x.toLowerCase() === "tsmc"));
  assert.equal(watchKeyOf("  "), null, "空白名不能变成一个关注");
  assert.equal(watchKeyOf("x"), null, "单字太泛，拒绝");
});

test("歧义词没有上下文就不推", () => {
  const apple = watchKeyOf("苹果");
  assert.ok(apple);
  const fruit = matchStory(apple, "苹果价格今年涨了两成");
  assert.equal(fruit.matched, false, "水果新闻不能被当成苹果公司");
  assert.equal(fruit.ambiguous, true, "要记成歧义，而不是无关");
  const inc = matchStory(apple, "苹果财报超预期，iPhone 销量回升");
  assert.equal(inc.matched, true);
  assert.equal(inc.ambiguous, false);
});

test("加关注幂等；别人的关注互不可见", () => {
  freshDataDir();
  const first = addWatch("u1", { name: "台积电" });
  assert.equal(first.created, true);
  const again = addWatch("u1", { name: "TSMC" });
  assert.equal(again.created, false, "同一个实体的别名不该出现第二条");
  assert.equal(again.watch.id, first.watch.id);
  assert.equal(listWatches("u1").length, 1);
  assert.equal(listWatches("u2").length, 0, "另一个账号看不到");
});

test("一条新闻只算一次命中（重复跑 cron 不刷屏）", () => {
  freshDataDir();
  const { watch } = addWatch("u1", { name: "台积电" });
  const stories = [story("TSMC 亚利桑那厂开始量产", "https://example.com/a")];
  const round1 = recordHits(stories);
  assert.equal(round1.inserted, 1);
  const round2 = recordHits(stories);
  assert.equal(round2.inserted, 0, "同一条 URL 第二次不该入库");
  assert.equal(countUnread("u1"), 1);
  const page = listHits("u1");
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0].watchId, watch.id);
  assert.equal(page.items[0].watchName, "台积电");
});

test("歧义命中只计数，不入库", () => {
  freshDataDir();
  addWatch("u1", { name: "苹果" });
  const result = recordHits([story("苹果价格今年涨了两成", "https://example.com/fruit")]);
  assert.equal(result.inserted, 0);
  assert.equal(result.ambiguous, 1);
  assert.equal(countUnread("u1"), 0);
});

test("已读：点开置位、重复标幂等、别人的 id 改不动", () => {
  freshDataDir();
  addWatch("u1", { name: "台积电" });
  recordHits([story("TSMC 财报", "https://example.com/1")]);
  const hit = listHits("u1").items[0];
  assert.equal(countUnread("u1"), 1);

  assert.equal(markRead("u2", [hit.id]), 0, "别人的未读不能被外部改掉");
  assert.equal(countUnread("u1"), 1);

  assert.equal(markRead("u1", [hit.id]), 1);
  assert.equal(countUnread("u1"), 0);
  assert.equal(markRead("u1", [hit.id]), 0, "已读再标一次不该再计数");

  const after = listHits("u1").items[0];
  assert.equal(after.read, true);
});

test("取消关注连命中一起删（不保留不该记得的东西）", () => {
  freshDataDir();
  const { watch } = addWatch("u1", { name: "台积电" });
  recordHits([story("TSMC 财报", "https://example.com/1")]);
  assert.equal(removeWatch("u1", watch.id), true);
  assert.equal(listHits("u1").items.length, 0, "级联删除：命中不能成孤儿");
  assert.deepEqual(watchStats(), { watches: 0, hits: 0, unread: 0 });
  assert.equal(removeWatch("u2", watch.id), false, "别人的关注删不掉");
});

test("每人关注上限兜住磁盘", () => {
  freshDataDir();
  withEnv({ PROBE_WATCH_PER_USER: "2" }, () => {
    addWatch("u1", { name: "台积电" });
    addWatch("u1", { name: "英伟达" });
    assert.throws(() => addWatch("u1", { name: "OpenAI" }), /watch_cap/);
    // 别的账号不受影响
    assert.doesNotThrow(() => addWatch("u2", { name: "OpenAI" }));
  });
});

test("每个关注的命中上限：老的先走", () => {
  freshDataDir();
  withEnv({ PROBE_WATCH_HITS_PER_WATCH: "2" }, () => {
    addWatch("u1", { name: "台积电" });
    recordHits([
      story("TSMC 一号", "https://example.com/1"),
      story("TSMC 二号", "https://example.com/2"),
      story("TSMC 三号", "https://example.com/3"),
    ]);
    const items = listHits("u1", { limit: 50 }).items;
    assert.equal(items.length, 2, "上限之外的要删掉");
  });
});

test("过期命中会被 cron 里的 pruneHits 清掉", () => {
  freshDataDir();
  addWatch("u1", { name: "台积电" });
  recordHits([story("TSMC 老新闻", "https://example.com/old")], Date.now() - 40 * DAY);
  assert.equal(listHits("u1").items.length, 1);
  assert.equal(pruneHits(), 1);
  assert.equal(listHits("u1").items.length, 0);
});

test("全部标已读会连未读计数一起归零", () => {
  freshDataDir();
  addWatch("u1", { name: "台积电" });
  recordHits([story("TSMC 一号", "https://example.com/1"), story("TSMC 二号", "https://example.com/2")]);
  assert.equal(countUnread("u1"), 2);
  assert.equal(markAllRead("u1"), 2);
  assert.equal(countUnread("u1"), 0);
});

test("开关：关注跟着历史走，任一关掉就整件关掉", () => {
  withEnv({ PROBE_WATCH_SERVER: "0" }, () => assert.equal(watchEnabled(), false));
  withEnv({ PROBE_HISTORY_SERVER: "0" }, () => assert.equal(watchEnabled(), false));
  withEnv({ PROBE_WATCH_SERVER: "1", PROBE_HISTORY_SERVER: "1" }, () => assert.equal(watchEnabled(), true));
});

test("建议关注：按出现次数，排除已关注的", () => {
  freshDataDir();
  saveQuery({ userId: "u1", query: "英伟达 H200 出口", region: "intl", entities: ["英伟达", "台积电"] });
  saveQuery({ userId: "u1", query: "英伟达财报", region: "intl", entities: ["英伟达"] });
  addWatch("u1", { name: "台积电" });
  const items = suggestWatches("u1", 5);
  assert.deepEqual(items, ["英伟达"], "已关注的不再建议，出现多的排前面");
  assert.deepEqual(suggestWatches("u2", 5), [], "别人的历史不该变成我的建议");
});

test("纯匹配函数不碰数据库：watch × story 的笛卡尔积 + 稳定顺序", () => {
  const watches = [
    { id: "w1", aliases: ["台积电", "TSMC"] },
    { id: "w2", aliases: ["苹果"] },
  ];
  const stories = [
    story("TSMC 亚利桑那厂量产", "https://example.com/1"),
    story("苹果价格涨了两成", "https://example.com/2"),
    story("与两个关注都无关的一条", "https://example.com/3"),
  ];
  const out = matchHits(watches, stories);
  assert.equal(out.hits.length, 1);
  assert.equal(out.hits[0].watchId, "w1");
  assert.equal(out.ambiguous, 1);
});

test("清空关注：只清自己的", () => {
  freshDataDir();
  addWatch("u1", { name: "台积电" });
  addWatch("u2", { name: "台积电" });
  assert.equal(clearWatches("u1"), 1);
  assert.equal(listWatches("u1").length, 0);
  assert.equal(listWatches("u2").length, 1);
});
