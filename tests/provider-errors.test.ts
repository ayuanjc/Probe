import assert from "node:assert/strict";
import test from "node:test";
import { classifyFailure, failureCode, isTerminalFailure } from "@/lib/provider-errors";

test("博查 403 带额度措辞 → quota，不带 → auth", () => {
  // 原文照录，这个是真实响应体。
  assert.equal(
    classifyFailure(new Error("bocha http 403 You do not have enough money or package quota")),
    "quota",
  );
  assert.equal(classifyFailure(new Error("bocha http 403 Forbidden")), "auth");
});

test("Tavily 的 432/433 是套餐用量，不是语法错误", () => {
  assert.equal(classifyFailure(new Error("tavily http 432")), "quota");
  assert.equal(classifyFailure(new Error("tavily http 433")), "quota");
});

test("限流、超时、401 各归各的", () => {
  assert.equal(classifyFailure(new Error("gdelt http 429")), "rate_limited");
  assert.equal(classifyFailure(new Error("tavily http 401")), "auth");
  assert.equal(classifyFailure(new Error("The operation timed out")), "timeout");
  assert.equal(classifyFailure(new Error("gdelt cooldown")), "failed");
  assert.equal(classifyFailure("something odd"), "failed");
});

test("failureCode 把 provider 与分类拼起来；额度与认证属于别再试的那类", () => {
  assert.equal(failureCode("bocha", new Error("bocha http 402")), "bocha:quota");
  assert.equal(isTerminalFailure("quota"), true);
  assert.equal(isTerminalFailure("auth"), true);
  assert.equal(isTerminalFailure("rate_limited"), false);
  assert.equal(isTerminalFailure("timeout"), false);
});
