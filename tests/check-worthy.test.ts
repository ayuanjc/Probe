import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
  CHECK_WORTHY_THRESHOLD,
  EVIDENCE_TOKENS_PER_CLAIM,
  checkWorthy,
  selectVerifiable,
} from "../src/lib/check-worthy";
import type { Claim } from "../src/lib/schemas";

function claim(value: string, quote: string, attr = "指标", kind: Claim["kind"] = "quantitative"): Claim {
  return { attr, value, quote, kind, sourceIds: ["s1"] };
}

test("阈值就是 0.4，界面上的「预算」说法依赖它", () => {
  assert.equal(CHECK_WORTHY_THRESHOLD, 0.4);
});

test("数字 + 够长的引文 → 保留", () => {
  const s = checkWorthy(claim("$3.2B", "营收同比增长 3.2%，达到 32 亿美元。"));
  assert.equal(s, 0.6);
  assert.ok(s >= CHECK_WORTHY_THRESHOLD);
});

test("短主体（换 CEO 这类）+ 长引文 → 刚好过线", () => {
  const s = checkWorthy(
    claim("黄仁勋", "公司宣布，黄仁勋将继续担任首席执行官，负责下一代平台的推进。", "CEO"),
  );
  assert.equal(s, 0.45);
  assert.ok(s >= CHECK_WORTHY_THRESHOLD);
  assert.ok(s >= CHECK_WORTHY_THRESHOLD);
});

test("写成一句话的叙述不是事实点：不加主体分，落到线下", () => {
  const s = checkWorthy(claim("公司表示将加大在华投资力度", "公司表示将加大在华投资力度，具体金额未披露。"));
  assert.equal(s, 0.3);
  assert.ok(s < CHECK_WORTHY_THRESHOLD);
});

test("模糊且无数字 → 0，核它就是白烧 token", () => {
  assert.equal(checkWorthy(claim("显著提升", "市场需求显著提升。")), 0);
});

test("全角数字也算数字（中文材料里很常见）", () => {
  assert.ok(checkWorthy(claim("３７％", "同比增长３７％。")) >= 0.45);
});

test("日期是独立锚点，可与数字叠加", () => {
  const s = checkWorthy(claim("2026-03-18", "该决定于 2026-03-18 正式生效，覆盖全部产线。"));
  assert.ok(s >= 0.6);
});

test("selectVerifiable：按分数降序，同分保持原顺序", () => {
  const claims = [
    claim("显著提升", "市场需求显著提升。"), // 0
    claim("$3.2B", "营收同比增长 3.2%，达到 32 亿美元。"), // 0.6
    claim("公司表示将加大在华投资力度", "公司表示将加大在华投资力度，具体金额未披露。"), // 0.3
    claim("2026-03-18", "该决定于 2026-03-18 正式生效，覆盖全部产线。"), // 0.6
  ];
  const g = selectVerifiable(claims);
  assert.equal(g.kept.length, 2);
  assert.equal(g.skipped.length, 2);
  // 3 号是「日期 + 引文」，得分 0.75；1 号是「数字 + 引文」，得分 0.60 —— 按分数降序。
  assert.deepEqual(g.kept.map((k) => k.index), [3, 1]);
  assert.equal(g.savedCalls, 2);
  assert.equal(g.savedTokens, 2 * EVIDENCE_TOKENS_PER_CLAIM);
});

test("selectVerifiable：空输入不抛、不做多余统计", () => {
  const g = selectVerifiable([]);
  assert.equal(g.kept.length, 0);
  assert.equal(g.skipped.length, 0);
  assert.equal(g.savedCalls, 0);
});
