import test from "node:test";
import assert from "node:assert/strict";

import { citedOwnersOf, hasHighAuthorityConflict, scoresFrom } from "@/agents/verify-pipeline";
import { buildDossier } from "@/lib/dossier";
import type { Claim, ClaimVerdict } from "@/lib/schemas";
import type { EvidenceAuthority } from "@/lib/dossier";

function claim(attr: string, value: string): Claim {
  return { attr, value, quote: "原文片段 " + attr + " 至少四个字", sourceIds: ["doc"], kind: "quantitative" };
}

function verdict(i: number, v: ClaimVerdict["verdict"], ids: string[] = []): ClaimVerdict {
  return { claimIndex: i, verdict: v, reason: "", evidenceIds: ids };
}

test("scoresFrom：零判定时评级 N/A，agreement 必须是 null 而不是 0.5", () => {
  const dossier = buildDossier({ claims: [claim("营收", "32 亿")], verdicts: [] });
  const scores = scoresFrom(dossier, false, false);
  assert.equal(scores.grade, "N/A");
  assert.equal(scores.agreement, null);
  assert.equal(scores.nEff, 0);
  assert.equal(scores.counts.judged, 0);
  assert.equal(scores.rows.length, 1);
  assert.equal(scores.rows[0].status, "unverified");
});

test("scoresFrom：三支持一反对 → 吻合度 0.75、judged 4、评级有字母", () => {
  const claims = [claim("a", "1"), claim("b", "2"), claim("c", "3"), claim("d", "4")];
  const evidence: EvidenceAuthority[] = [
    { id: "e1", owner: "o1", authority: 1 },
    { id: "e2", owner: "o2", authority: 1 },
    { id: "e3", owner: "o3", authority: 1 },
    { id: "e4", owner: "o4", authority: 1 },
  ];
  const verdicts = [
    verdict(0, "support", ["e1"]),
    verdict(1, "support", ["e2"]),
    verdict(2, "support", ["e3"]),
    verdict(3, "contradict", ["e4"]),
  ];
  const dossier = buildDossier({ claims, verdicts, evidence });
  const scores = scoresFrom(dossier, false, hasHighAuthorityConflict(verdicts, new Map(evidence.map((e) => [e.id, e]))));
  assert.equal(scores.counts.judged, 4);
  assert.equal(scores.counts.supported, 3);
  assert.equal(scores.counts.contradicted, 1);
  assert.ok(scores.agreement !== null);
  assert.equal(scores.agreement?.value, 0.75);
  assert.equal(scores.nEff, 4);
  assert.notEqual(scores.grade, "N/A");
  // 单家来源矛盾不足以压档：四票里只有一票反对，没有「≥2 家权威同时顶回来」。
  assert.equal(scores.capped, false);
});

test("scoresFrom：partial 原样透传（中断与 N/A 是两件事）", () => {
  const dossier = buildDossier({ claims: [claim("a", "1")], verdicts: [] });
  assert.equal(scoresFrom(dossier, true, false).partial, true);
  assert.equal(scoresFrom(dossier, false, false).partial, false);
});

test("hasHighAuthorityConflict：两家 0.7+ 独立 owner 反对同一条才算", () => {
  const claims = [claim("a", "1")];
  const evidence: EvidenceAuthority[] = [
    { id: "e1", owner: "reuters.com", authority: 0.7 },
    { id: "e2", owner: "apnews.com", authority: 0.7 },
  ];
  const auth = new Map(evidence.map((e) => [e.id, e]));
  // 同一条 claim 被两家权威顶回来 → 算
  assert.equal(hasHighAuthorityConflict([verdict(0, "contradict", ["e1", "e2"])], auth), true);
  // 只有一家 → 不算
  assert.equal(hasHighAuthorityConflict([verdict(0, "contradict", ["e1"])], auth), false);
  // 两条 claim 各被一家顶回来 → 不算（不同结论各输一次，不是同一结论被两家否定）
  assert.equal(
    hasHighAuthorityConflict([verdict(0, "contradict", ["e1"]), verdict(1, "contradict", ["e2"])], auth),
    false,
  );
  // 权威度不够门槛 → 不算
  const low = new Map([["e9", { id: "e9", owner: "blog.example", authority: 0.6 }]]);
  assert.equal(hasHighAuthorityConflict([verdict(0, "contradict", ["e9"])], low), false);
  // 同一家两个栏目算一家
  const same = new Map([
    ["e1", { id: "e1", owner: "reuters.com", authority: 0.7 }],
    ["e2", { id: "e2", owner: "REUTERS.com", authority: 0.7 }],
  ]);
  assert.equal(hasHighAuthorityConflict([verdict(0, "contradict", ["e1", "e2"])], same), false);
});

test("hasHighAuthorityConflict：support 与 silent 不参与", () => {
  const auth = new Map([
    ["e1", { id: "e1", owner: "a.gov", authority: 0.9 }],
    ["e2", { id: "e2", owner: "b.gov", authority: 0.9 }],
  ]);
  assert.equal(hasHighAuthorityConflict([verdict(0, "support", ["e1", "e2"])], auth), false);
  assert.equal(hasHighAuthorityConflict([verdict(0, "neutral", ["e1", "e2"])], auth), false);
});

test("citedOwnersOf：给 url 就回一个 owner，没 url 回空数组", () => {
  assert.deepEqual(citedOwnersOf("https://www.reuters.com/x/y"), [citedOwnersOf("https://reuters.com/x")[0]]);
  assert.equal(citedOwnersOf("https://www.reuters.com/x/y").length, 1);
  assert.deepEqual(citedOwnersOf(null), []);
  assert.deepEqual(citedOwnersOf(""), []);
});
