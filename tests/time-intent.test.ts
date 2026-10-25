import assert from "node:assert/strict";
import test from "node:test";
import { hasExplicitTimeWindow } from "@/lib/time-intent";

test("明确的时间词算有时间窗约束", () => {
  for (const q of [
    "铜价最近三个月为什么涨",
    "本周 AI 融资",
    "2026年9月的英伟达股价",
    "上周发布的模型有哪些",
    "过去一年碳酸锂产能变化",
    "10月24日 发生了什么",
    "Q3 财报对比",
    "last week chip news",
    "30 days ago copper",
  ]) {
    assert.equal(hasExplicitTimeWindow(q), true, q);
  }
});

test("没有刻度就不算 —— 「最近」不构成约束", () => {
  for (const q of [
    "铜价为什么涨",
    "英伟达估值合理吗",
    "最近铜价怎么样",
    "AI 数据中心 供需",
    "how does copper pricing work",
    "",
  ]) {
    assert.equal(hasExplicitTimeWindow(q), false, q);
  }
});

test("数字本身不是时间：价格与百分比不能误判", () => {
  for (const q of [
    "铜价 9500 美元意味着什么",
    "毛利率 30% 的公司有哪些",
    // 光写一个年份不算时间约束：它是数据点（"2026 这个数字"），不是刻度。
    // 带上「年」或「月」才成为时间 —— ABSOLUTE 里那几条要的就是这个区别。
    "2026 这个数字在统计里怎么用",
  ]) {
    assert.equal(hasExplicitTimeWindow(q), false, q);
  }
});
