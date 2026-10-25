import { test } from "node:test";
import assert from "node:assert/strict";
import { extractKeyFigures, magnitudeOfValue } from "../src/lib/key-figures";
import type { Claim, Confidence, RawSource } from "../src/lib/schemas";

function src(over: Partial<RawSource> & { id: string; snippet: string }): RawSource {
  return {
    url: "https://example.com/" + over.id,
    domain: "example.com",
    owner: "例网",
    title: over.title ?? "标题",
    lang: "zh",
    publishedAt: "2025-10-01T00:00:00.000Z",
    provider: "fixture",
    ...over,
  } as RawSource;
}

function conf(band: Confidence["band"]): Confidence {
  return {
    independence: 0.5,
    firstHand: 0.5,
    consistency: 0.5,
    score: band === "low" ? 0.3 : 0.8,
    band,
    nOwners: 2,
    nSyndicated: 0,
    nChecked: 1,
    nConflicts: 0,
  };
}

test("从原文句子里抽出带单位的数值，并带上原文切片", () => {
  const r = extractKeyFigures({
    sources: [src({ id: "a1", snippet: "本季度毛利率为 12.6%，较去年同期略有回落。" })],
    claims: [],
    confidence: conf("high"),
  });
  assert.equal(r.mode, "snippets");
  assert.equal(r.figures.length, 1);
  const f = r.figures[0];
  assert.equal(f.value, "12.6%");
  assert.equal(f.unit, "%");
  assert.equal(f.kind, "percent");
  assert.deepEqual(f.sourceIds, ["a1"]);
  // quote 必须是原文子串（Phase 2 复核 model quote 用的是同一套 indexOf 判据）
  assert.ok("本季度毛利率为 12.6%，较去年同期略有回落。".includes(f.quote));
});

test("纯四位年份、版本号、长数字串都不当数据", () => {
  const r = extractKeyFigures({
    sources: [
      src({ id: "a1", snippet: "2025 年公司发布了 v2 版本，订单号 2025100198877 已作废。" }),
    ],
    claims: [],
    confidence: conf("high"),
  });
  assert.equal(r.figures.length, 0);
  assert.ok(r.notes.includes("figures:none"));
});

test("无单位数字不进表（宁可漏，不许猜口径）", () => {
  const r = extractKeyFigures({
    sources: [src({ id: "a1", snippet: "用户数增长了 12，团队扩到 40 左右。" })],
    claims: [],
    confidence: conf("high"),
  });
  assert.equal(r.figures.length, 0);
});

test("单位顺序：万亿元不能被切成万", () => {
  const r = extractKeyFigures({
    sources: [src({ id: "a1", snippet: "该项目总投资 1.2 万亿元，分三期建设。" })],
    claims: [],
    confidence: conf("high"),
  });
  assert.equal(r.figures.length, 1);
  assert.equal(r.figures[0].unit, "万亿");
  assert.equal(magnitudeOfValue(r.figures[0]), 1.2e12);
});

test("同量级不同写法合并成一行，并把信源并起来", () => {
  const r = extractKeyFigures({
    sources: [
      src({ id: "a1", snippet: "全年营收 1.2 万亿元。" }),
      src({ id: "a2", snippet: "全年营收 1.2 万亿元。" }),
    ],
    claims: [],
    confidence: conf("high"),
  });
  assert.equal(r.figures.length, 1);
  assert.deepEqual(r.figures[0].sourceIds.sort(), ["a1", "a2"]);
});

test("claims 在线时用 attr 当指标名，mode 不再标 snippets", () => {
  const claim: Claim = {
    attr: "毛利率",
    value: "12.6",
    unit: "%",
    quote: "本季度毛利率为 12.6%",
    sourceIds: ["a1"],
    kind: "quantitative",
  };
  const r = extractKeyFigures({
    sources: [src({ id: "a1", snippet: "本季度毛利率为 12.6%，较去年同期略有回落。" })],
    claims: [claim],
    confidence: conf("medium"),
  });
  assert.equal(r.mode, "claims");
  assert.equal(r.figures[0].label, "毛利率");
  assert.equal(r.figures[0].value, "12.6%");
  assert.equal(r.figures[0].kind, "percent");
  assert.ok(!r.notes.includes("figures:from_snippets"));
});

test("claim 的 sourceId 不在本轮信源里就丢（无源不显示）", () => {
  const claim: Claim = {
    attr: "毛利率",
    value: "12.6",
    unit: "%",
    quote: "本季度毛利率为 12.6%",
    sourceIds: ["ghost"],
    kind: "quantitative",
  };
  const r = extractKeyFigures({
    sources: [src({ id: "a1", snippet: "本季度毛利率为 12.6%。" })],
    claims: [claim],
    confidence: conf("medium"),
  });
  assert.equal(r.figures.length, 1);
  assert.deepEqual(r.figures[0].sourceIds, ["a1"]);
  assert.equal(r.mode, "snippets");
});

test("低置信要多说一句：这批数字没有交叉核对", () => {
  const r = extractKeyFigures({
    sources: [src({ id: "a1", snippet: "装机量 14GWh。" })],
    claims: [],
    confidence: conf("low"),
  });
  assert.ok(r.notes.includes("figures:low_confidence_uncrossed"));
  assert.ok(r.notes.includes("figures:from_snippets"));
});

test("量词与计价分母跟着单位一起留（1200万辆 / 0.68元W）", () => {
  const r = extractKeyFigures({
    sources: [src({ id: "a1", snippet: "全年销量 1200万辆，组件报价 0.68元/W。" })],
    claims: [],
    confidence: conf("high"),
  });
  const values = r.figures.map((f) => f.value).sort();
  assert.deepEqual(values, ["0.68元/W", "1200万辆"]);
});

test("同一个数被反复扫到只留一行，指标名取最短的那条", () => {
  const r = extractKeyFigures({
    sources: [
      src({ id: "a1", snippet: "2025年第三季度 光伏组件价格 0.68元/W 下跌 12%" }),
      src({ id: "a2", snippet: "分析师下调2025年第三季度 光伏组件价格 0.68元/W 目标价" }),
    ],
    claims: [],
    confidence: conf("high"),
  });
  const price = r.figures.filter((f) => f.value === "0.68元/W");
  assert.equal(price.length, 1);
  assert.equal(price[0].label, "光伏组件价格");
  assert.deepEqual(price[0].sourceIds.sort(), ["a1", "a2"]);
});

test("时间窗能抽出来，且不越过句子边界", () => {
  const r = extractKeyFigures({
    sources: [src({ id: "a1", snippet: "2025年第三季度出货 14GWh。下一句不相干。" })],
    claims: [],
    confidence: conf("high"),
  });
  assert.equal(r.figures[0].period, "2025年第三季度");
  assert.ok(!r.figures[0].quote.includes("下一句"));
});
