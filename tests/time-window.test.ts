import assert from "node:assert/strict";
import test from "node:test";
import { parseInstant, partitionByWindow, windowBoundsMs } from "@/lib/time-window";

const FROM = Date.parse("2026-09-25T00:00:00.000Z");
const TO = Date.parse("2026-10-25T00:00:00.000Z");

const src = (id: string, publishedAt: string, provider = "tavily") => ({ id, publishedAt, provider });

test("没有发布日期等于「未知」，不等于「今天」，也不算越界", () => {
  // 这条钉的是 2026-10-25 的事故：Tavily basic depth 不回 published_date，
  // 取数代码写成 ?? new Date().toISOString()，结果 15 条全被判成「比窗口末端还晚」。
  const items = [src("a", ""), src("b", "not-a-date"), src("c", undefined as unknown as string)];
  const p = partitionByWindow(items, FROM, TO);
  assert.equal(p.kept.length, 3);
  assert.equal(p.dropped.length, 0);
  assert.equal(p.undated.length, 3);
});

test("窗外按上界/下界分别丢弃，并按 provider 计数", () => {
  const items = [
    src("old", "2026-01-01T00:00:00.000Z", "gdelt"),
    src("future", "2026-12-01T00:00:00.000Z", "bocha"),
    src("edge-from", "2026-09-25T00:00:00.000Z", "gdelt"),
    src("edge-to", "2026-10-25T00:00:00.000Z", "wiki"),
  ];
  const p = partitionByWindow(items, FROM, TO);
  assert.deepEqual(p.kept.map((s) => s.id), ["edge-from", "edge-to"]);
  assert.deepEqual(p.dropped.map((s) => s.id), ["old", "future"]);
  assert.deepEqual(p.droppedByProvider, { gdelt: 1, bocha: 1 });
  assert.equal(p.undated.length, 0);
});

test("provider 缺省的条目也要记账，不能因为没名字就静默消失", () => {
  const p = partitionByWindow([{ id: "x", publishedAt: "2020-01-01T00:00:00.000Z" }], FROM, TO);
  assert.deepEqual(p.droppedByProvider, { unknown: 1 });
});

test("parseInstant：NaN、空串、null 一律 null，不是 0", () => {
  assert.equal(parseInstant(""), null);
  assert.equal(parseInstant(null), null);
  assert.equal(parseInstant("2026-10-24"), Date.parse("2026-10-24"));
  assert.equal(parseInstant("2026-13-45"), null);
});

test("窗口上界解析不出来时才退化成「现在之后一天」，下界退化成不设限", () => {
  const now = Date.parse("2026-10-25T00:00:00.000Z");
  const ok = windowBoundsMs("2026-10-01", "2026-10-20", now);
  assert.equal(ok.fromMs, Date.parse("2026-10-01"));
  assert.equal(ok.toMs, Date.parse("2026-10-20"));
  const bad = windowBoundsMs("garbage", "garbage", now);
  assert.equal(bad.fromMs, 0);
  assert.equal(bad.toMs, now + 86_400_000);
});
test("只有日精度的日期按「整天」算在窗口内", () => {
  // 窗口下界是 9/25 01:42，URL 推导出的 9/25 发生在零点 —— 那一条必须留着。
  const items = [src("day-in", "2026-09-25", "tavily"), src("day-out", "2026-09-24", "tavily")];
  const fromMs = Date.parse("2026-09-25T01:42:11.556Z");
  const p = partitionByWindow(items, fromMs, TO);
  assert.deepEqual(p.kept.map((s) => s.id), ["day-in"]);
  assert.deepEqual(p.dropped.map((s) => s.id), ["day-out"]);
  assert.equal(p.undated.length, 0);
});
