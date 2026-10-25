import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { hasExplicitTimeWindow } from "@/lib/time-intent";

// 测试从仓库根目录跑（package.json 的 test 脚本），用相对 cwd 的路径而不是 import.meta：
// tsconfig.test.json 编译成 commonjs，import.meta 在那里不合法。
const src = readFileSync("src/agents/retrieve.ts", "utf8");

/**
 * 这两条是「多打一次 news」的护栏：它花的是真钱。
 * 一旦有人把闸门去掉或把它挪到区域判断之前，成本就会在没人注意的地方翻倍 ——
 * 而且翻倍时的症状是「结果变好了」，最难被发现。
 */

test("news 检索受「明确时间窗」闸门控制", () => {
  assert.match(src, /hasExplicitTimeWindow\(intent\.query\)/);
  const gateAt = src.indexOf("hasExplicitTimeWindow(intent.query)");
  const newsAt = src.indexOf("topic: \"news\"");
  assert.ok(gateAt > 0 && newsAt > gateAt, "news 调用必须在闸门之后");
});

test("news 的 id 前缀与 general 分开，否则 sourceIds 会指错稿子", () => {
  assert.match(src, /idPrefix: "tvn-"/);
  assert.match(src, /id: idPrefix \+ i/);
});

test("闸门只认明确时间词（抽样，防有人把它放宽成「永远 true」）", () => {
  assert.equal(hasExplicitTimeWindow("铜价最近三个月为什么涨"), true);
  assert.equal(hasExplicitTimeWindow("铜价为什么涨"), false);
});
