/**
 * 按人额度：第二道闸。
 *
 * 全局计数器（PROBE_DAILY_LLM_CALLS）是一个人也能烧穿的 —— 一轮核验就是几十次
 * 上游调用，连点几下「生成面板」同样。这里验的是三条**顺序性质**：
 *   1. 谁的额度用完谁自己降级，别人不受影响；
 *   2. 个人被拦时不能消耗全局额度（否则一个人的狂点会让全站提前降级）；
 *   3. 没有请求上下文 / 用户自带 key 时，这道闸一律放行。
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  __testResetGlobalBudget,
  __testResetScopeBudget,
  __testTakeBudget,
  budgetUsed,
  scopeBudgetExhausted,
  scopeBudgetUsed,
} from "@/lib/llm";
import { currentCallScopeKey, runWithCallScope } from "@/lib/call-scope";

const ENV_KEYS = [
  "OPENAI_API_KEY",
  "PROBE_DAILY_LLM_CALLS",
  "PROBE_DAILY_LLM_CALLS_PER_USER",
] as const;

/** 造一个「服务端自带 key」的现场，并在用例结束后原样还原。 */
function withEnv(patch: Record<string, string>, fn: () => void | Promise<void>) {
  const saved = new Map<string, string | undefined>();
  for (const k of ENV_KEYS) saved.set(k, process.env[k]);
  try {
    for (const [k, v] of Object.entries(patch)) process.env[k] = v;
    return fn();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

function fresh(patch: Record<string, string>) {
  __testResetGlobalBudget();
  for (const k of ["u:a", "u:b", "u:c"]) __testResetScopeBudget(k);
  return patch;
}

test("上下文：runWithCallScope 内看得到，出了作用域就没了", async () => {
  assert.equal(currentCallScopeKey(), undefined);
  await runWithCallScope({ key: "u:a", label: "用户 a" }, async () => {
    assert.equal(currentCallScopeKey(), "u:a");
    await Promise.resolve();
    // 跨 await 之后仍在（SSE 的 start() 就是在 await 之后才跑）
    assert.equal(currentCallScopeKey(), "u:a");
  });
  assert.equal(currentCallScopeKey(), undefined);
});

test("额度：一个人用完不影响另一个人，且全局只记通过的次数", () => {
  withEnv(fresh({ OPENAI_API_KEY: "env-key", PROBE_DAILY_LLM_CALLS: "1000", PROBE_DAILY_LLM_CALLS_PER_USER: "2" }), () => {
    const before = budgetUsed();

    const aFirst = runWithCallScope({ key: "u:a", label: "用户 a" }, () => __testTakeBudget());
    const aSecond = runWithCallScope({ key: "u:a", label: "用户 a" }, () => __testTakeBudget());
    const aThird = runWithCallScope({ key: "u:a", label: "用户 a" }, () => __testTakeBudget());
    assert.deepEqual([aFirst, aSecond, aThird], [true, true, false]);

    // 同一个人换个身份也跑不掉（额度按账号，不按请求）
    assert.equal(runWithCallScope({ key: "u:a", label: "用户 a" }, () => scopeBudgetExhausted()), true);
    assert.equal(scopeBudgetUsed("u:a"), 2);

    // 另一个人不受牵连
    const bFirst = runWithCallScope({ key: "u:b", label: "用户 b" }, () => __testTakeBudget());
    assert.equal(bFirst, true);
    assert.equal(runWithCallScope({ key: "u:b", label: "用户 b" }, () => scopeBudgetExhausted()), false);

    // 全局只涨了 3（a 的前两次 + b 的一次），a 被拦下的那次没有记账
    assert.equal(budgetUsed() - before, 3);
  });
});

test("额度：没有请求上下文时，个人这道闸一律放行", () => {
  withEnv(fresh({ OPENAI_API_KEY: "env-key", PROBE_DAILY_LLM_CALLS: "1000", PROBE_DAILY_LLM_CALLS_PER_USER: "1" }), () => {
    // 先把 u:a 用满
    runWithCallScope({ key: "u:a", label: "用户 a" }, () => {
      __testTakeBudget();
      assert.equal(__testTakeBudget(), false);
    });

    // 无上下文（比如后台的定时任务、或流的 start() 没绑上）不该被某个人的额度牵连
    assert.equal(scopeBudgetExhausted(), false);
    assert.equal(__testTakeBudget(), true);
  });
});

test("额度：全局耗尽时所有人都停（总闸在个人闸之前）", () => {
  withEnv(fresh({ OPENAI_API_KEY: "env-key", PROBE_DAILY_LLM_CALLS: "2", PROBE_DAILY_LLM_CALLS_PER_USER: "100" }), () => {
    assert.equal(runWithCallScope({ key: "u:a", label: "用户 a" }, () => __testTakeBudget()), true);
    assert.equal(runWithCallScope({ key: "u:b", label: "用户 b" }, () => __testTakeBudget()), true);
    // 全局用完：换谁来都不行
    assert.equal(runWithCallScope({ key: "u:c", label: "用户 c" }, () => __testTakeBudget()), false);
    // 而且个人账本没有被虚记（拦在总闸时还没走到个人计数）
    assert.equal(scopeBudgetUsed("u:c"), 0);
  });
});

test("额度：用户自带 key（服务端没有 key）时不计额度", () => {
  withEnv(fresh({ PROBE_DAILY_LLM_CALLS: "1", PROBE_DAILY_LLM_CALLS_PER_USER: "1" }), () => {
    delete process.env.OPENAI_API_KEY;
    // keySource() === "none"：花的是用户自己的钱，额度这道闸不该生效
    runWithCallScope({ key: "u:a", label: "用户 a" }, () => {
      assert.equal(__testTakeBudget(), true);
      assert.equal(__testTakeBudget(), true);
      assert.equal(scopeBudgetExhausted(), false);
    });
    assert.equal(budgetUsed(), 0);
  });
});
