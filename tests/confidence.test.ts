import { test } from "node:test";
import { strict as assert } from "node:assert";
import { computeConfidence, effectiveOwners, ownerOf } from "../src/lib/confidence";
import type { RawSource } from "../src/lib/schemas";

function src(id: string, owner: string, title?: string): RawSource {
  return {
    id,
    url: "https://" + owner + "/" + id,
    domain: owner,
    owner,
    title: title ?? "稿件 " + id,
    snippet: "",
    lang: "zh",
    publishedAt: "2026-03-18T02:00:00.000Z",
    provider: "tavily",
  };
}

test("effectiveOwners：全一手时 n_eff 等于 owner 数", () => {
  const sources = [src("a1", "a.example"), src("b1", "b.example"), src("c1", "c.example")];
  const e = effectiveOwners(sources);
  assert.equal(e.nOwners, 3);
  assert.equal(e.nEff, 3);
  assert.deepEqual(e.distributors, []);
});

test("effectiveOwners：只有转载的 owner 被降权，n_eff 立刻小于 owner 数", () => {
  const sources = [src("a1", "a.example"), src("b1", "b.example"), src("c1", "c.example")];
  const e = effectiveOwners(sources, ["c1"]);
  assert.equal(e.nOwners, 3);
  assert.deepEqual(e.weights, [1, 1, 0.3]);
  assert.ok(Math.abs(e.nEff - (2.3 * 2.3) / 2.09) < 1e-9);
  assert.deepEqual(e.distributors, ["c.example"]);
});

test("effectiveOwners：同一家多篇一手仍然是 1 票（相关性没变）", () => {
  const sources = [src("a1", "a.example"), src("a2", "a.example"), src("b1", "b.example")];
  const e = effectiveOwners(sources);
  assert.equal(e.nOwners, 2);
  assert.deepEqual(e.weights, [1, 1]);
  assert.equal(e.nEff, 2);
});

test("ownerOf：没有 owner 时回落到域名，且统一小写", () => {
  const s = { ...src("a1", ""), owner: "", url: "https://News.Example.COM/x" };
  assert.equal(ownerOf(s), "example.com");
});

test("computeConfidence 回归（CODE-REVIEW #5）：不给 ctx 时一手性虚高到 1", () => {
  // 这些条目是「去重之后」的存活集合：重复稿已经被 dedupe 吃掉了，
  // 所以 findSyndicatedIds 在这上面几乎永远返回空集 —— 这就是那个 bug。
  const sources = [
    src("s1", "a.example"),
    src("s2", "b.example"),
    src("s3", "c.example"),
    src("s4", "d.example"),
  ];
  const c = computeConfidence(sources, []);
  assert.equal(c.firstHand, 1);
  assert.equal(c.nSyndicated, 0);
});

test("computeConfidence：给了 rawCount + 转载池，一手性回到真实比例", () => {
  const sources = [
    src("s1", "a.example"),
    src("s2", "b.example"),
    src("s3", "c.example"),
    src("s4", "d.example"),
  ];
  // 原始 40 条，其中 31 条是转载（含被 dedupe 合并掉的）
  const ids = Array.from({ length: 31 }, (_, i) => "r" + i);
  const c = computeConfidence(sources, [], { rawCount: 40, syndicatedIds: ids });
  assert.ok(Math.abs(c.firstHand - (1 - 31 / 40)) < 1e-9);
  assert.equal(c.nSyndicated, 31);
  assert.ok(c.firstHand < 0.3, "一手性应被转载大幅拉低");
});

test("computeConfidence：mergedIds 会被并进转载池（重复稿不算一手）", () => {
  const sources = [src("s1", "a.example"), src("s2", "b.example")];
  const c = computeConfidence(sources, [], { rawCount: 4, mergedIds: ["m1", "m2"] });
  assert.equal(c.nSyndicated, 2);
  assert.equal(c.firstHand, 0.5);
});

test("computeConfidence：分母不会被压到小于存活条数（firstHand 不超过 1）", () => {
  const sources = [src("s1", "a.example"), src("s2", "b.example")];
  const c = computeConfidence(sources, [], { rawCount: 1 });
  assert.equal(c.firstHand, 1);
});

test("computeConfidence：没有可核对断言时封顶 0.64，不进高档", () => {
  const sources = [src("s1", "a.example"), src("s2", "b.example"), src("s3", "c.example")];
  const c = computeConfidence(sources, []);
  assert.equal(c.nChecked, 0);
  assert.ok(c.score <= 0.64);
  assert.notEqual(c.band, "high");
});

test("computeConfidence：单个 owner 封顶 0.45", () => {
  const sources = [src("s1", "a.example"), src("s2", "a.example")];
  const c = computeConfidence(sources, []);
  assert.equal(c.nOwners, 1);
  assert.ok(c.score <= 0.45);
});

test("computeConfidence：整批 fixture 一律低档", () => {
  const sources = [src("s1", "a.example"), src("s2", "b.example")].map((s) => ({
    ...s,
    provider: "fixture" as const,
  }));
  const c = computeConfidence(sources, []);
  assert.ok(c.score <= 0.34);
  assert.equal(c.band, "low");
});
