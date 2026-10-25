import assert from "node:assert/strict";
import test from "node:test";
import { dateFromUrl } from "@/lib/date-from-url";

const NOW = Date.parse("2026-10-25T00:00:00.000Z");

test("分隔符形状：/2026/10/24/ 与 2026-10-24", () => {
  assert.equal(dateFromUrl("https://finance.sina.com.cn/2026/10/24/x.html", NOW), "2026-10-24");
  assert.equal(dateFromUrl("https://a.example/2026-10-24/report", NOW), "2026-10-24");
  assert.equal(dateFromUrl("https://a.example/news/2026_1_5/a", NOW), "2026-01-05");
});

test("连续数字：8 位日期后面跟时分秒或序号都能认", () => {
  assert.equal(
    dateFromUrl("https://www.cngold.com.cn/202610242184529872.html", NOW),
    "2026-10-24",
  );
  assert.equal(dateFromUrl("https://a.example/20261024/index.html", NOW), "2026-10-24");
});

test("认不出就 null，绝不猜", () => {
  // 搜狐的稿件 id 是 10 位流水号，前 8 位当日期会得到 1091 年 —— 必须拒绝。
  assert.equal(dateFromUrl("https://www.sohu.com/a/1091763649_115124", NOW), null);
  assert.equal(dateFromUrl("https://timeline.sohu.com/news/PS27EMutyH", NOW), null);
  assert.equal(dateFromUrl("https://a.example/article", NOW), null);
  assert.equal(dateFromUrl("", NOW), null);
});

test("不合理日期一律拒绝（月份/日越界、闰年）", () => {
  assert.equal(dateFromUrl("https://a.example/2026/13/01/x", NOW), null);
  assert.equal(dateFromUrl("https://a.example/2026/02/30/x", NOW), null);
  assert.equal(dateFromUrl("https://a.example/2027/02/29/x", NOW), null);
  assert.equal(dateFromUrl("https://a.example/2024/02/29/x", NOW), "2024-02-29");
  assert.equal(dateFromUrl("https://a.example/1989/10/24/x", NOW), null);
});
