/**
 * 事件时间线：把同一件事的多家报道折成一个事件，并按档位分叉。
 *
 * 每条断言对着一个具体后果：
 *   - 全都并成一条 → 抹掉「谁先说、谁没确认」；
 *   - 一条都不并 → 时间线变成重复列表，读者自己数重复；
 *   - 主干取了最新而不是最权威的 → 二手转述压过一手发布；
 *   - 分叉不标「说法不一致」→ 我们把两个说法当成一件事。
 */
import test from "node:test";
import assert from "node:assert/strict";

import { buildTimeline, similarity, titleTokens } from "@/lib/entity-timeline";
import type { EntityHit } from "@/lib/entity-track";

const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 9, 26, 0, 0, 0);

function hit(over: Partial<EntityHit> & { title: string; url: string }): EntityHit {
  return {
    id: over.url,
    key: "台积电",
    name: "台积电",
    kind: "org",
    host: null,
    provider: null,
    points: 0,
    seenAt: null,
    at: T0,
    ...over,
  };
}

test("标题 token：英文取 ≥3 词、中文用 2-gram、数字保留、停用词去掉", () => {
  const t = titleTokens("苹果 发布 iPhone 17 Pro，2026 年销量第一");
  assert.ok(t.has("iphone"));
  assert.ok(t.has("pro"));
  assert.ok(t.has("2026"));
  assert.ok(t.has("苹果"));
  assert.ok(t.has("发布"), "中文应有 2-gram");
  assert.ok(t.has("销量"), "中文 2-gram 跨词时按标点切段，段内相邻两字都算");
  assert.ok(!t.has("the"));
  assert.ok(!t.has("的"));
});

test("相似度：同一标题为 1，无关标题接近 0，空标题恒 0", () => {
  const a = titleTokens("台积电 3nm 产能满载");
  assert.equal(similarity(a, titleTokens("台积电 3nm 产能满载")), 1);
  assert.ok(similarity(a, titleTokens("OpenAI 发布新模型")) < 0.1);
  assert.equal(similarity(new Set(), a), 0);
});

test("同一事件的多家报道聚成一个事件，主干取档位最高的那条", () => {
  const hits = [
    hit({ title: "台积电 3nm 产能满载 订单排到明年", url: "https://www.ithome.com/a", host: "www.ithome.com", at: T0 + 5 * HOUR }),
    hit({ title: "台积电 3nm 产能满载，订单排到明年", url: "https://www.reuters.com/a", host: "www.reuters.com", at: T0 + 2 * HOUR }),
    hit({ title: "台积电 3nm 产能满载 订单排到明年", url: "https://top.baidu.com/a", provider: "baidu", at: T0 + 6 * HOUR }),
  ];
  const events = buildTimeline(hits);
  assert.equal(events.length, 1, "三家说同一件事应聚成一个事件");
  const e = events[0];
  assert.equal(e.main.host, "www.reuters.com", "主流媒体应压过行业媒体与聚合榜");
  assert.equal(e.main.tier, 2);
  assert.equal(e.branches.length, 2);
  assert.deepEqual(e.tiers, [2, 3, 4]);
  assert.equal(e.spanHours, 4, "跨度 = 最后一条 - 最早一条");
  assert.equal(e.firstAt, T0 + 2 * HOUR);
  assert.equal(e.divergent, false, "标题几乎一致不算说法不一");
});

test("同档取更早的那条：先说的人更接近源头", () => {
  const hits = [
    hit({ title: "英伟达 Q3 营收超预期", url: "https://www.reuters.com/1", host: "www.reuters.com", at: T0 + 3 * HOUR }),
    hit({ title: "英伟达 Q3 营收超预期", url: "https://apnews.com/2", host: "apnews.com", at: T0 + HOUR }),
  ];
  const e = buildTimeline(hits)[0];
  assert.equal(e.main.host, "apnews.com");
});

test("时间窗之外的同一标题不合并（旧闻不会把新事件吸走）", () => {
  const hits = [
    hit({ title: "台积电 3nm 产能满载", url: "https://www.reuters.com/old", host: "www.reuters.com", at: T0 }),
    hit({ title: "台积电 3nm 产能满载", url: "https://www.reuters.com/new", host: "www.reuters.com", at: T0 + 100 * HOUR }),
  ];
  assert.equal(buildTimeline(hits).length, 2);
  // 把窗口放大到 200 小时就应当合并
  assert.equal(buildTimeline(hits, { windowHours: 200 }).length, 1);
});

test("分支与主干说法差异大时标 divergent，并保留相似度", () => {
  const hits = [
    hit({ title: "台积电 3nm 产能满载 订单排到明年", url: "https://www.reuters.com/a", host: "www.reuters.com", at: T0 }),
    // 只有「台积电」「产能」这些词相同，其余全不同 —— 相似度低但仍过得了 0.2 的门槛
    hit({ title: "台积电 产能 收缩 传闻 四起", url: "https://www.ithome.com/b", host: "www.ithome.com", at: T0 + 2 * HOUR }),
  ];
  const e = buildTimeline(hits, { threshold: 0.2 })[0];
  assert.equal(e.branches.length, 1);
  assert.ok(e.branches[0].similarity < 0.55, "相似度应低: " + e.branches[0].similarity);
  assert.equal(e.divergent, true);
});

test("每个事件的分支数受 maxBranches 限制，主干不在 branches 里", () => {
  const hits = Array.from({ length: 9 }, (_, i) =>
    hit({ title: "台积电 3nm 产能满载", url: "https://www.ithome.com/" + i, host: "www.ithome.com", at: T0 + i * HOUR }),
  );
  const e = buildTimeline(hits, { maxBranches: 3 })[0];
  assert.equal(e.branches.length, 3);
  assert.ok(e.branches.every((b) => b.id !== e.main.id));
  // 主干是 9 条里最早的那条
  assert.equal(e.main.at, T0);
});

test("输出按事件时间倒序：最新的在最上面", () => {
  const hits = [
    hit({ title: "台积电 3nm 产能满载", url: "https://a.com/1", host: "reuters.com", at: T0 }),
    hit({ title: "OpenAI 发布新模型 参数翻倍", url: "https://a.com/2", host: "reuters.com", at: T0 + 50 * HOUR }),
  ];
  const events = buildTimeline(hits);
  assert.equal(events.length, 2);
  assert.ok(events[0].at > events[1].at);
});

test("空输入返回空数组（页面走空态，不是崩）", () => {
  assert.deepEqual(buildTimeline([]), []);
});
