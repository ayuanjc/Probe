import test from "node:test";
import assert from "node:assert/strict";

import {
  MIN_QUOTE_CHARS,
  digitsOf,
  locateQuote,
  normalize,
  verifyExtractedClaim,
} from "@/lib/claim-extract";

const TEXT =
  "英伟达在 2026 财年第三季度实现数据中心收入 32 亿美元，同比增长 112%。" +
  "黄仁勋表示，这一增长主要由新一代加速卡带动。\n\n" +
  "公司同时宣布，Blackwell 架构将于 2026 年 11 月 3 日进入量产。";

test("定位：直接命中，偏移落在原文坐标系", () => {
  const loc = locateQuote(TEXT, "数据中心收入 32 亿美元");
  assert.ok(loc);
  assert.equal(TEXT.slice(loc!.charStart, loc!.charEnd), "数据中心收入 32 亿美元");
});

test("定位：模型重排空白后仍能命中，并回推原文区间", () => {
  const loc = locateQuote(TEXT, "黄仁勋表示，这一增长主要由\n新一代加速卡带动");
  assert.ok(loc);
  // 原文那里没有空白，quote 里塞了一个换行 —— 归一化后仍应命中，且区间回推到原句。
  assert.equal(TEXT.slice(loc!.charStart, loc!.charEnd), "黄仁勋表示，这一增长主要由新一代加速卡带动");
});

test("定位：全角标点被折成半角也能命中", () => {
  const loc = locateQuote(TEXT, "表示,这一增长");
  assert.ok(loc);
  assert.equal(TEXT.slice(loc!.charStart, loc!.charEnd), "表示，这一增长");
});

test("定位：找不到返回 null，不做模糊匹配", () => {
  assert.equal(locateQuote(TEXT, "数据中心营收 32 亿美元"), null);
});

test("定位：quote 太短直接 null（三五个字在任何文章里都能命中）", () => {
  assert.equal(locateQuote(TEXT, "英伟达"), null);
  assert.ok(MIN_QUOTE_CHARS > 3);
});

test("定位：offset 让区间变成全文坐标", () => {
  const seg = "数据中心收入 32 亿美元";
  const loc = locateQuote(seg, "收入 32 亿美元", 100);
  assert.ok(loc);
  assert.equal(loc!.charStart - 100, seg.indexOf("收入"));
  assert.equal(seg.slice(loc!.charStart - 100, loc!.charEnd - 100), "收入 32 亿美元");
});

test("归一化：折全角、压空白、去尾部空格", () => {
  assert.equal(normalize("  （a，b）\n\n c  "), "(a,b)c");
});

test("数字序列：去掉千分位，保留小数", () => {
  assert.deepEqual(digitsOf("收入 1,234.5 亿，同比 12%"), ["1234.5", "12"]);
});

test("复核：数字对得上就通过", () => {
  const r = verifyExtractedClaim(TEXT, {
    quote: "数据中心收入 32 亿美元",
    attr: "数据中心收入",
    value: "32",
    unit: "亿美元",
    kind: "quantitative",
  });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.claim.kind, "quantitative");
    assert.equal(TEXT.slice(r.claim.charStart, r.claim.charEnd), "数据中心收入 32 亿美元");
  }
});

test("复核：值里的数字在 quote 里找不到 → value_mismatch", () => {
  const r = verifyExtractedClaim(TEXT, {
    quote: "数据中心收入 32 亿美元",
    attr: "数据中心收入",
    value: "23",
    unit: "亿美元",
    kind: "quantitative",
  });
  assert.deepEqual(r, { ok: false, code: "value_mismatch" });
});

test("复核：quote 编造 → quote_miss", () => {
  const r = verifyExtractedClaim(TEXT, {
    quote: "数据中心收入 32 亿美元，同比增长 210%",
    attr: "同比",
    value: "210",
    unit: "%",
    kind: "quantitative",
  });
  assert.deepEqual(r, { ok: false, code: "quote_miss" });
});

test("复核：quote 太短 → quote_short", () => {
  const r = verifyExtractedClaim(TEXT, { quote: "英伟达", attr: "a", value: "b", kind: "existence" });
  assert.deepEqual(r, { ok: false, code: "quote_short" });
});

test("复核：kind 不在取值表里 → kind_invalid（不猜）", () => {
  const r = verifyExtractedClaim(TEXT, {
    quote: "数据中心收入 32 亿美元",
    attr: "数据中心收入",
    value: "32",
    kind: "numeric",
  });
  assert.deepEqual(r, { ok: false, code: "kind_invalid" });
});

test("复核：归属类不查数字，人名对得上即可", () => {
  const r = verifyExtractedClaim(TEXT, {
    quote: "黄仁勋表示，这一增长主要由新一代加速卡带动",
    attr: "表态",
    value: "黄仁勋",
    kind: "attribution",
  });
  assert.equal(r.ok, true);
});

test("复核：temporal 断言没有数字 → value_mismatch", () => {
  const r = verifyExtractedClaim(TEXT, {
    quote: "Blackwell 架构将于 2026 年 11 月 3 日进入量产",
    attr: "量产时间",
    value: "年内",
    kind: "temporal",
  });
  assert.deepEqual(r, { ok: false, code: "value_mismatch" });
});