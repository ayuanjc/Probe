/**
 * 事件流 → 历史记录的折叠规则。
 *
 * 这一层最容易悄悄变坏：路由里的 for-await 只多一行 observe()，
 * 少抄一个字段界面上只是「数字不对」，没人会报 bug。所以每条都钉住。
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  newSearchTrace,
  newVerifyTrace,
  observeSearchEvent,
  observeVerifyEvent,
  searchTraceToQuery,
  verifyTraceToQuery,
} from "@/lib/history-collect";

const ctx = { userId: "u1", query: "存储芯片", region: "cn", modelHost: "api.deepseek.com" };

test("搜索：intent / 摘要长度 / 信源 / done 都抄进索引，引文只留 hash", () => {
  const trace = newSearchTrace();
  observeSearchEvent(trace, { event: "intent", data: { kind: "lookup", entities: [{ name: "台积电" }, { name: "台积电" }] } });
  observeSearchEvent(trace, { event: "text.delta", data: { delta: "12345" } });
  observeSearchEvent(trace, { event: "text.delta", data: { delta: "678" } });
  observeSearchEvent(trace, {
    event: "sources",
    data: { sources: [{ url: "https://a.example/1", title: "标题", owner: "bocha", quote: "原文里的那句话" }] },
  });
  observeSearchEvent(trace, {
    event: "done",
    data: { elapsedMs: 1234, claims: [{ attr: "a" }, { attr: "b" }], degraded: ["claims:quote_miss_3"] },
  });

  const q = searchTraceToQuery(trace, ctx);
  assert.ok(q);
  assert.equal(q?.intentKind, "lookup");
  // 同名实体只留一个：共现图那侧已经去过重，历史里重复只会撑长列表。
  assert.deepEqual(q?.entities, ["台积电"]);
  assert.equal(q?.summaryLen, 8);
  assert.equal(q?.claims, 2);
  assert.equal(q?.elapsedMs, 1234);
  assert.deepEqual(q?.degraded, ["claims:quote_miss_3"]);
  assert.equal(q?.sources?.[0].provider, "bocha");
  // 关键：落库的是 hash，不是那句原文。
  assert.match(String(q?.sources?.[0].quoteHash), /^[0-9a-f]{16}$/);
  assert.equal(JSON.stringify(q).includes("原文里的那句话"), false);
  // 搜索阶段没有判定，三态一律 0，界面显示「未核验」。
  assert.equal(q?.supported, 0);
  assert.equal(q?.contradicted, 0);
  assert.equal(q?.unknownN, 0);
});

test("搜索：一条事件都没看到（立刻断开）不留痕", () => {
  const trace = newSearchTrace();
  assert.equal(searchTraceToQuery(trace, ctx), null);
});

test("搜索：模型没回 done 时也保留已经拿到的部分，elapsed 记 0", () => {
  const trace = newSearchTrace();
  observeSearchEvent(trace, { event: "sources", data: { sources: [{ url: "https://a.example/1", owner: "wiki" }] } });
  const q = searchTraceToQuery(trace, ctx);
  assert.ok(q);
  assert.equal(q?.elapsedMs, 0);
  assert.equal(q?.sources?.length, 1);
});

test("搜索：畸形事件被忽略，不抛", () => {
  const trace = newSearchTrace();
  observeSearchEvent(trace, { event: "sources", data: null });
  observeSearchEvent(trace, { event: "sources", data: { sources: [null, 3, { url: "" }, {}] } });
  observeSearchEvent(trace, { event: "done", data: { elapsedMs: "x", claims: "不是数组", degraded: 5 } });
  const q = searchTraceToQuery(trace, ctx);
  assert.ok(q);
  assert.equal(q?.sources?.length, 0);
  assert.equal(q?.claims, 0);
});

test("核验：done.scores.counts 折成三态，标题当 query，正文 hash 进 doc_hash", () => {
  const trace = newVerifyTrace();
  observeVerifyEvent(trace, { event: "doc.parsed", data: { title: "某篇报道", chars: 4321 } });
  observeVerifyEvent(trace, {
    event: "done",
    data: {
      elapsedMs: 90_000,
      degraded: ["llm:user_budget"],
      scores: { counts: { supported: 4, contradicted: 1, unverified: 3, unverifiable: 2, judged: 5, verifiable: 8 } },
    },
  });

  const q = verifyTraceToQuery(trace, { ...ctx, query: "", body: "正文全文" });
  assert.ok(q);
  assert.equal(q?.query, "某篇报道");
  assert.equal(q?.intentKind, "verify");
  assert.equal(q?.summaryLen, 4321);
  assert.deepEqual({ s: q?.supported, c: q?.contradicted, u: q?.unknownN }, { s: 4, c: 1, u: 3 });
  // claims = verifiable + unverifiable：两条口径合起来才是「抽出来多少条」。
  assert.equal(q?.claims, 10);
  assert.match(String(q?.docHash), /^[0-9a-f]{16}$/);
  // 核验的证据是留出集临时结果，不存（存下来等于把「读过什么」也交了）。
  assert.equal(q?.sources?.length, 0);
});

test("核验：连正文都没拿到（没有 doc.parsed）就不留记录", () => {
  const trace = newVerifyTrace();
  observeVerifyEvent(trace, { event: "error", data: { message: "抓不到" } });
  assert.equal(verifyTraceToQuery(trace, ctx), null);
});
