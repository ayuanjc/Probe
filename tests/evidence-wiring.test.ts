import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { makeHeldoutDeps, tavilyHeldoutSearch } from "@/agents/heldout";
import { withRuntimeConfig } from "@/lib/runtime-config";

/**
 * 这道测试守的是一行「接线」而不是一个算法：/api/evidence 曾经把 makeHeldoutDeps 的 search
 * 传成字面 undefined，于是不管配没配 key，deps 恒为 null，永远走「没有留出集检索器」，
 * 一条证据都检索不到、一条样本也落不下。算法单测全绿也发现不了这种事 —— 所以直接读源码。
 */
const ROUTE = path.join(process.cwd(), "src/app/api/evidence/route.ts");

test("断言核验接口自己造检索器，不把 search 写死", () => {
  const src = readFileSync(ROUTE, "utf8");
  assert.ok(
    !/search:\s*undefined/.test(src),
    "search 又被写死成 undefined 了 —— 整条核验会永远没有留出集",
  );
  assert.ok(
    src.includes("tavilyHeldoutSearch("),
    "路由必须调用 tavilyHeldoutSearch() 来造检索器",
  );
  assert.ok(
    src.includes("llmEnabled("),
    "缺判定器要单独报 —— 找到了证据没人判，和找不到证据是两件事",
  );
});

/**
 * 现在有两道闸：有没有 key，以及这个区域能不能用境外检索。
 * 少了第二道，境内请求会把查询词发给 Tavily —— 那是数据出境，测试必须钉住。
 */
test("配了 TAVILY_API_KEY 且区域允许，才有检索器", () => {
  const saved = process.env.TAVILY_API_KEY;
  try {
    delete process.env.TAVILY_API_KEY;
    assert.equal(
      withRuntimeConfig({ region: "intl" }, () => tavilyHeldoutSearch()),
      null,
      "没有 key 时必须返回 null，不能假装能搜",
    );
    process.env.TAVILY_API_KEY = "tvly-test-only";
    // 区域闸门：境内即使有 key 也不给检索器（数据不出境）
    assert.equal(
      withRuntimeConfig({ region: "cn" }, () => tavilyHeldoutSearch()),
      null,
      "境内不该拿得到 Tavily 检索器",
    );
    assert.equal(
      typeof withRuntimeConfig({ region: "intl" }, () => tavilyHeldoutSearch()),
      "function",
    );
  } finally {
    if (saved === undefined) delete process.env.TAVILY_API_KEY;
    else process.env.TAVILY_API_KEY = saved;
  }
});

test("有检索器时 deps 两个函数都在，缺检索器时整包为 null", () => {
  const judge = async () => null;
  const deps = makeHeldoutDeps({ search: async () => [], judge, citedOwners: [] });
  assert.ok(deps);
  assert.equal(typeof deps.findEvidence, "function");
  assert.equal(typeof deps.judge, "function");
  assert.equal(makeHeldoutDeps({ search: null, judge, citedOwners: [] }), null);
});