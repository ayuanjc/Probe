/**
 * partial 的口径：只数「系统真的少看了东西」的三件事 —— 正文被截、段落超上限、断言超预算。
 * 闸门跳过（观点/预测/模糊断言）与检索/判定失败不算，那两种情况下字母档仍然是整篇的。
 */
import test from "node:test";
import assert from "node:assert/strict";

import { coverageGaps } from "@/agents/verify-pipeline";
import { coverageGapText } from "@/lib/verify-events";

const CLEAN = { truncated: false, segmentsTotal: 10, segmentsExtracted: 10, claimsGated: 5, claimsPicked: 5 };

test("全程没缺：理由是空数组（partial 就是 false）", () => {
  assert.deepEqual(coverageGaps(CLEAN), []);
});

test("正文被截 → doc:truncated", () => {
  assert.deepEqual(coverageGaps({ ...CLEAN, truncated: true }), ["doc:truncated"]);
});

test("段落超上限 → 只抽了前几段", () => {
  assert.deepEqual(coverageGaps({ ...CLEAN, segmentsTotal: 24, segmentsExtracted: 12 }), [
    "segments:extracted_12_of_24",
  ]);
});

test("断言超预算 → 只核了前几条（注意这是 gate 之后的数，闸门跳过不算）", () => {
  assert.deepEqual(coverageGaps({ ...CLEAN, claimsGated: 31, claimsPicked: 12 }), ["claims:capped_12_of_31"]);
});

test("闸门跳过本身不是 partial：过了闸的都能核，就还是整篇", () => {
  // 10 条断言里 8 条被闸门判为不值得核，剩下 2 条全核了。
  assert.deepEqual(coverageGaps({ ...CLEAN, claimsGated: 2, claimsPicked: 2 }), []);
});

test("三件同时发生 → 三个理由，顺序固定（doc → segments → claims）", () => {
  assert.deepEqual(
    coverageGaps({ truncated: true, segmentsTotal: 24, segmentsExtracted: 12, claimsGated: 31, claimsPicked: 12 }),
    ["doc:truncated", "segments:extracted_12_of_24", "claims:capped_12_of_31"],
  );
});

test("理由码翻人话：三条映射 + 未知码原样返回", () => {
  assert.equal(coverageGapText("doc:truncated"), "正文超过 4 万字，后半篇没读");
  assert.equal(coverageGapText("segments:extracted_12_of_24"), "全文 24 段里只从 12 段抽了断言");
  assert.equal(coverageGapText("claims:capped_12_of_31"), "过闸 31 条断言，只核了前 12 条");
  // 未知码不许翻成空字符串：界面上宁可看见机器码，也不要看见一句空白。
  assert.equal(coverageGapText("weird:code"), "weird:code");
});

test("代码与文案成对：coverageGaps 产出的每个码都能翻出人话", () => {
  const all = coverageGaps({
    truncated: true,
    segmentsTotal: 3,
    segmentsExtracted: 1,
    claimsGated: 9,
    claimsPicked: 2,
  });
  for (const code of all) {
    const text = coverageGapText(code);
    assert.notEqual(text, code, code + " 没有对应的中文文案");
    assert.ok(text.length > 0);
  }
});
