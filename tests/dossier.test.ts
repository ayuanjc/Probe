import test from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_AUTHORITY, buildDossier } from "@/lib/dossier";
import type { Claim, ClaimVerdict } from "@/lib/schemas";

function claim(attr: string, value: string, kind: Claim["kind"] = "quantitative"): Claim {
  return { attr, value, quote: "原文片段 " + attr + " 至少四个字", sourceIds: ["s1"], kind };
}

function verdict(i: number, v: ClaimVerdict["verdict"], ids: string[] = []): ClaimVerdict {
  return { claimIndex: i, verdict: v, reason: "", evidenceIds: ids };
}

test("三支持一反对：吻合度按 owner 权重算，n_eff 是四个独立源", () => {
  const claims = [claim("a", "1"), claim("b", "2"), claim("c", "3"), claim("d", "4")];
  const verdicts = [
    verdict(0, "support", ["e1"]),
    verdict(1, "support", ["e2"]),
    verdict(2, "support", ["e3"]),
    verdict(3, "contradict", ["e4"]),
  ];
  const evidence = [
    { id: "e1", owner: "a.example", authority: 1 },
    { id: "e2", owner: "b.example", authority: 1 },
    { id: "e3", owner: "c.example", authority: 1 },
    { id: "e4", owner: "d.example", authority: 1 },
  ];
  const r = buildDossier({ claims, verdicts, evidence });
  assert.deepEqual(r.counts, {
    supported: 3,
    contradicted: 1,
    unverified: 0,
    unverifiable: 0,
    judged: 4,
    verifiable: 4,
  });
  assert.equal(r.view.nEff, 4);
  assert.equal(r.view.agreement?.value, 0.75);
  assert.equal(r.view.agreement?.n, 4);
  assert.equal(r.view.tooltip.coverage, 1);
  assert.equal(r.view.fakeConsensus, null);
  assert.equal(r.blocked, null);
  assert.deepEqual(r.degraded, []);
  assert.ok(r.view.agreement !== null && r.view.agreement.low < 0.75 && r.view.agreement.high > 0.75);
});

test("四票支持里三票是转载：假共识溢价被点亮", () => {
  const claims = [claim("a", "1"), claim("b", "2"), claim("c", "3"), claim("d", "4"), claim("e", "5")];
  const verdicts = [
    verdict(0, "support", ["e1"]),
    verdict(1, "support", ["e2"]),
    verdict(2, "support", ["e3"]),
    verdict(3, "support", ["e4"]),
    verdict(4, "contradict", ["e5"]),
  ];
  const evidence = [
    { id: "e1", owner: "first.example", authority: 1 },
    { id: "e2", owner: "copy-a.example", authority: 0.3 },
    { id: "e3", owner: "copy-b.example", authority: 0.3 },
    { id: "e4", owner: "copy-c.example", authority: 0.3 },
    { id: "e5", owner: "doubt.example", authority: 0.8 },
  ];
  const r = buildDossier({ claims, verdicts, evidence });
  // 朴素 4/5 = 0.8；加权 1.9 / 2.7 = 0.7037 —— 差出来的就是转载撑起的那部分。
  assert.equal(r.view.tooltip.naive, 0.8);
  assert.ok(Math.abs((r.view.agreement?.value ?? 0) - 1.9 / 2.7) < 1e-12);
  assert.ok(Math.abs((r.view.fakeConsensus?.premium ?? 0) - (0.8 - 1.9 / 2.7)) < 1e-12);
  assert.equal(r.view.fakeConsensus?.nSupport, 4);
  assert.equal(r.view.fakeConsensus?.nContra, 1);
});

test("自证不算票：本文引过的 owner 被剔除，support 降级为未找到证据", () => {
  const claims = [claim("revenue", "32 亿美元")];
  const verdicts = [verdict(0, "support", ["e1"])];
  const r = buildDossier({
    claims,
    verdicts,
    evidence: [{ id: "e1", owner: "www.NVIDIA.com", authority: 1 }],
    citedOwners: ["nvidia.com"],
  });
  assert.equal(r.rows[0].status, "unverified");
  assert.deepEqual(r.rows[0].evidenceIds, []);
  assert.match(r.rows[0].reason, /不在留出集里/);
  assert.ok(r.degraded.includes("dossier:self_citation_dropped_e1"));
  assert.equal(r.view.agreement, null);
  assert.equal(r.blocked, "no_evidence");
});

test("全不可核：blocked 是 all_unverifiable，可核验率没有分母", () => {
  const claims = [claim("trend", "将翻倍", "prediction"), claim("why", "因为涨价", "causal")];
  const r = buildDossier({
    claims,
    verdicts: [verdict(0, "neutral"), verdict(1, "neutral")],
    evidence: [],
  });
  assert.equal(r.counts.unverifiable, 2);
  assert.equal(r.counts.verifiable, 0);
  assert.equal(r.view.tooltip.coverage, null);
  assert.equal(r.blocked, "all_unverifiable");
  assert.equal(r.view.agreement, null);
  assert.equal(r.rows[0].weight, 0);
});

test("证据缺 authority 时按 0.6 记并留账", () => {
  const r = buildDossier({
    claims: [claim("a", "1")],
    verdicts: [verdict(0, "support", ["e1"])],
    evidence: [{ id: "e1", owner: "a.example" }],
  });
  assert.equal(r.view.agreement?.value, 1);
  assert.equal(r.degraded[0], "dossier:authority_default_e1");
  assert.equal(DEFAULT_AUTHORITY, 0.6);
});

test("同一 owner 给三条证据仍然只算一个独立源", () => {
  const claims = [claim("a", "1"), claim("b", "2"), claim("c", "3")];
  const verdicts = [
    verdict(0, "support", ["e1"]),
    verdict(1, "support", ["e2"]),
    verdict(2, "support", ["e3"]),
  ];
  const evidence = [
    { id: "e1", owner: "same.example", authority: 1 },
    { id: "e2", owner: "same.example", authority: 1 },
    { id: "e3", owner: "same.example", authority: 1 },
  ];
  const r = buildDossier({ claims, verdicts, evidence });
  assert.equal(r.view.nEff, 1);
  // 一个来源的吻合度不是吻合度：界面据此写「无独立证据」，但数字本身仍是 100%。
  assert.equal(r.view.agreement?.value, 1);
});

test("空文档：blocked no_evidence，任何比例都不出现", () => {
  const r = buildDossier({ claims: [], verdicts: [] });
  assert.equal(r.rows.length, 0);
  assert.equal(r.view.agreement, null);
  assert.equal(r.view.nEff, 0);
  assert.equal(r.view.tooltip.coverage, null);
  assert.equal(r.blocked, "no_evidence");
});
