import { test } from "node:test";
import { strict as assert } from "node:assert";
import { alignVerdicts, verifyClaims } from "../src/agents/verify";
import type { HeldoutEvidence, VerifyDeps } from "../src/agents/verify";
import type { Claim, ClaimKind } from "../src/lib/schemas";

function claim(attr: string, value: string, kind: ClaimKind, quote = "原文片段，足够长可以过前置过滤"): Claim {
  return { attr, value, quote, kind, sourceIds: ["s1"] };
}

function evidence(id: string, owner: string): HeldoutEvidence {
  return { id, owner, url: "https://" + owner + "/" + id, title: "t", text: "外部材料原文" };
}

function deps(held: HeldoutEvidence[], verdict: "support" | "contradict" | "neutral" = "support"): VerifyDeps {
  return {
    findEvidence: async () => held,
    judge: async () => ({ verdict, reason: "照证据判", quote: "外部材料原文" }),
  };
}

test("没有留出集检索器：blocked，verdicts 为空，不可核条数照报", async () => {
  const claims = [claim("revenue", "32 亿美元", "quantitative"), claim("view", "值得关注", "opinion")];
  const r = await verifyClaims(claims, null);
  assert.equal(r.blocked, "no_heldout_retriever");
  assert.deepEqual(r.verdicts, []);
  assert.equal(r.unverifiable, 1);
});

test("不可核断言不进队列：直接落 neutral + 不可核验理由", async () => {
  const claims = [
    claim("revenue", "32 亿美元", "quantitative"),
    claim("view", "表现显著优于同行", "opinion"),
    claim("forecast", "2027 年出货量翻倍", "prediction"),
    claim("cause", "涨价导致需求下滑", "causal"),
  ];
  const r = await verifyClaims(claims, deps([evidence("e1", "reuters.com")]));
  assert.equal(r.unverifiable, 3);
  const byIndex = new Map(r.verdicts.map((v) => [v.claimIndex, v]));
  for (const i of [1, 2, 3]) {
    const v = byIndex.get(i);
    assert.ok(v, "不可核断言也要有 verdict，界面上是第四态");
    assert.equal(v.verdict, "neutral");
    assert.match(v.reason, /不可核验/);
  }
  assert.equal(byIndex.get(0)?.verdict, "support");
  // 三条不可核断言一条都不该进检索：进一次就白烧一次预算
  assert.equal(r.gate.kept.length, 1);
});

test("gate 的下标映射回原数组，不能指到别的断言上", async () => {
  const claims = [
    claim("view", "值得关注", "opinion"),
    claim("revenue", "32 亿美元", "quantitative"),
    claim("forecast", "明年翻倍", "prediction"),
    claim("launch", "2026 年 3 月发布", "temporal"),
  ];
  const r = await verifyClaims(claims, deps([evidence("e1", "reuters.com")]));
  const kept = r.gate.kept.map((k) => k.index).sort();
  assert.deepEqual(kept, [1, 3]);
  for (const k of r.gate.kept) {
    assert.equal(k.claim.kind, claims[k.index].kind);
    assert.equal(k.claim.attr, claims[k.index].attr);
  }
});

test("留出集为空 → neutral，理由点明「不计入分母」", async () => {
  const r = await verifyClaims([claim("revenue", "32 亿美元", "quantitative")], deps([]));
  assert.equal(r.verdicts.length, 1);
  assert.equal(r.verdicts[0].verdict, "neutral");
  assert.match(r.verdicts[0].reason, /不计入吻合度分母/);
  assert.deepEqual(r.verdicts[0].evidenceIds, []);
});

test("引用了同一家 owner 的材料不能给自己作证", async () => {
  const r = await verifyClaims(
    [claim("revenue", "32 亿美元", "quantitative")],
    deps([evidence("e1", "nvidia.com")]),
    { citedOwners: ["www.nvidia.com"] },
  );
  assert.equal(r.verdicts[0].verdict, "neutral");
  assert.match(r.verdicts[0].reason, /留出集为空/);
});

test("support 回填证据 id，neutral 不回填", async () => {
  const ok = await verifyClaims([claim("revenue", "32 亿美元", "quantitative")], deps([evidence("e1", "reuters.com")]));
  assert.deepEqual(ok.verdicts[0].evidenceIds, ["e1"]);
  const no = await verifyClaims(
    [claim("revenue", "32 亿美元", "quantitative")],
    deps([evidence("e1", "reuters.com")], "neutral"),
  );
  assert.deepEqual(no.verdicts[0].evidenceIds, []);
});

test("预算为 0 时 blocked=budget_exhausted，但不可核标注仍在", async () => {
  const claims = [claim("revenue", "32 亿美元", "quantitative"), claim("view", "值得关注", "opinion")];
  const r = await verifyClaims(claims, deps([evidence("e1", "reuters.com")]), { maxClaims: 0 });
  assert.equal(r.blocked, "budget_exhausted");
  assert.equal(r.verdicts.length, 1);
  assert.equal(r.verdicts[0].claimIndex, 1);
});

test("alignVerdicts：两类缺失给两种理由，不混成一句", () => {
  const claims = [claim("revenue", "32 亿美元", "quantitative"), claim("view", "值得关注", "opinion")];
  const aligned = alignVerdicts(claims, []);
  assert.match(aligned[0].reason, /未进入核验批次/);
  assert.match(aligned[1].reason, /不可核验/);
});
