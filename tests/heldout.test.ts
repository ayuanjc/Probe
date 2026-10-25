import test from "node:test";
import assert from "node:assert/strict";

import { MAX_QUERY_CHARS, buildEvidenceQuery, filterHeldout } from "@/lib/heldout";
import { makeHeldoutDeps, makeHeldoutRetriever } from "@/agents/heldout";
import type { HeldoutItem } from "@/lib/heldout";

function ev(id: string, owner: string, url = "https://" + owner + "/" + id): HeldoutItem {
  return { id, url, owner, title: "标题 " + id, text: "正文 " + id + " ".repeat(200) };
}

test("检索词：数字 + 单位在前，属性在后", () => {
  const q = buildEvidenceQuery({ kind: "quantitative", attr: "营收", value: "21.3", unit: "十亿美元" });
  assert.equal(q, "21.3 十亿美元 营收");
});

test("检索词：值里已带单位时不重复追加", () => {
  const q = buildEvidenceQuery({ kind: "quantitative", attr: "营收", value: "$3.2B", unit: "$3.2B" });
  assert.equal(q, "$3.2B 营收");
});

test("检索词：存在性断言只检索主体", () => {
  assert.equal(buildEvidenceQuery({ kind: "existence", attr: "是否上市", value: "英伟达" }), "英伟达");
});

test("检索词：去掉引号与换行并压空白", () => {
  const q = buildEvidenceQuery({ kind: "attribution", attr: "「CEO」", value: "黄仁勋\n" });
  assert.equal(q, "黄仁勋 CEO");
  assert.ok(!/[「」\n]/.test(q));
});

test("检索词：超长截断到上限", () => {
  const q = buildEvidenceQuery({ kind: "temporal", attr: "长".repeat(300), value: "2026-01-01" });
  assert.equal(q.length, MAX_QUERY_CHARS);
});

test("筛证据：自证整条剔除并记账", () => {
  const r = filterHeldout([ev("e1", "www.NVIDIA.com"), ev("e2", "reuters.com")], ["nvidia.com"]);
  assert.deepEqual(r.kept.map((x) => x.id), ["e2"]);
  assert.deepEqual(r.dropped, ["heldout:self_citation_e1"]);
});

test("筛证据：同 url 只留一份（忽略 query 与尾斜杠）", () => {
  const a = ev("e1", "reuters.com", "https://reuters.com/a");
  const b = ev("e2", "reuters.com", "https://reuters.com/a/?utm=1");
  const c = ev("e3", "apnews.com", "https://apnews.com/a/");
  const r = filterHeldout([a, b, c], []);
  assert.deepEqual(r.kept.map((x) => x.id), ["e1", "e3"]);
  assert.deepEqual(r.dropped, ["heldout:duplicate_e2"]);
});

test("筛证据：条数上限与正文截断", () => {
  const r = filterHeldout([ev("e1", "a.com"), ev("e2", "b.com"), ev("e3", "c.com")], [], {
    maxPerClaim: 2,
    maxTextChars: 80,
  });
  assert.equal(r.kept.length, 2);
  assert.equal(r.kept[0].text.length, 80);
  assert.deepEqual(r.dropped, ["heldout:capped_e3"]);
});

test("检索器：把检索词交给 search，并把自证剔掉", async () => {
  const calls: string[] = [];
  const find = makeHeldoutRetriever({
    citedOwners: ["nvidia.com"],
    search: async (query) => {
      calls.push(query);
      return [ev("e1", "nvidia.com"), ev("e2", "reuters.com")];
    },
  });
  const got = await find(
    { attr: "营收", value: "21.3", unit: "十亿美元", quote: "原文四个字", sourceIds: ["s1"], kind: "quantitative" },
    0,
  );
  assert.deepEqual(calls, ["21.3 十亿美元 营收"]);
  // 自证那条（nvidia.com）被剔掉，留下的是 reuters 那条。
  assert.deepEqual(got.map((x) => x.url), ["https://reuters.com/e2"]);
  /*
   * id 必须带 claimIndex。
   *
   * 上游检索器每次都从头编号（held-0、held-1…），不同断言之间必然撞号；
   * 消费方按 id 建 map 去重，撞号会让有效独立源数系统性少算 ——
   * 所以这里断言的是「带本断言下标」，不是某个具体名字。
   */
  assert.deepEqual(got.map((x) => x.id), ["held-0-0"]);
});

test("检索器：不同断定言的证据 id 不撞号", async () => {
  const find = makeHeldoutRetriever({
    citedOwners: [],
    search: async () => [ev("e1", "reuters.com"), ev("e2", "apnews.com")],
  });
  const claim = { attr: "营收", value: "1", quote: "原文四个字", sourceIds: ["s1"], kind: "quantitative" as const };
  const a = await find(claim, 3);
  const b = await find(claim, 7);
  assert.deepEqual(a.map((x) => x.id), ["held-3-0", "held-3-1"]);
  assert.deepEqual(b.map((x) => x.id), ["held-7-0", "held-7-1"]);
  assert.equal(new Set([...a, ...b].map((x) => x.id)).size, 4);
});

test("检索器：search 抛错时往上抛，不伪装成空集", async () => {
  const find = makeHeldoutRetriever({
    search: async () => {
      throw new Error("boom");
    },
  });
  await assert.rejects(
    () => find({ attr: "营收", value: "1", quote: "原文四个字", sourceIds: ["s1"], kind: "quantitative" }, 0),
    /boom/,
  );
});

test("deps：没有 search 就是 null（本轮不做外部核验）", () => {
  const deps = makeHeldoutDeps({ search: null, judge: async () => null });
  assert.equal(deps, null);
});

test("deps：有 search 时两个函数都在", () => {
  const deps = makeHeldoutDeps({
    search: async () => [],
    judge: async () => null,
  });
  assert.ok(deps);
  assert.equal(typeof deps?.findEvidence, "function");
  assert.equal(typeof deps?.judge, "function");
});