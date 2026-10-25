import test from "node:test";
import assert from "node:assert/strict";

import { buildDossier, pickJudged } from "@/lib/dossier";
import type { Claim, ClaimVerdict } from "@/lib/schemas";

function claim(attr: string, kind: Claim["kind"] = "quantitative"): Claim {
  return { attr, value: "1", quote: "原文片段 " + attr + " 足够长", sourceIds: ["s1"], kind };
}

function verdict(i: number, v: ClaimVerdict["verdict"], ids: string[] = []): ClaimVerdict {
  return { claimIndex: i, verdict: v, reason: "", evidenceIds: ids };
}

test("只有被判定的断言进入新数组，claimIndex 重排成新下标", () => {
  const claims = [claim("a"), claim("b"), claim("c"), claim("d")];
  // 1 与 3 被判过，0 与 2 没被核（预算或闸门跳过）。
  const picked = pickJudged(claims, [verdict(1, "support", ["e1"]), verdict(3, "contradict", ["e2"])]);
  assert.equal(picked.claims.length, 2);
  assert.deepEqual(
    picked.claims.map((c) => c.attr),
    ["b", "d"],
  );
  assert.deepEqual(
    picked.verdicts.map((v) => v.claimIndex),
    [0, 1],
  );
  assert.equal(picked.notJudged, 2);
});

test("重排后交给 buildDossier：没核过的断言不会变成「未找到证据」", () => {
  const claims = [claim("a"), claim("b"), claim("c")];
  const evidence = [{ id: "e1", owner: "x.example", authority: 1 }];
  const picked = pickJudged(claims, [verdict(1, "support", ["e1"])]);

  // 先看错误做法：全塞进去会把没核的两条记成 unverified。
  const wrong = buildDossier({ claims, verdicts: [verdict(1, "support", ["e1"])], evidence });
  assert.equal(wrong.counts.unverified, 2);

  const right = buildDossier({ claims: picked.claims, verdicts: picked.verdicts, evidence });
  assert.deepEqual(right.counts, {
    supported: 1,
    contradicted: 0,
    unverified: 0,
    unverifiable: 0,
    judged: 1,
    verifiable: 1,
  });
  assert.equal(right.rows[0].attr, "b");
});

test("同一 claimIndex 给两次判定时以后一条为准，不炸也不重复计数", () => {
  const claims = [claim("a"), claim("b")];
  const picked = pickJudged(claims, [
    verdict(0, "support", ["e1"]),
    verdict(0, "contradict", ["e2"]),
    verdict(0, "neutral"),
  ]);
  assert.equal(picked.claims.length, 1);
  assert.equal(picked.verdicts.length, 1);
  assert.equal(picked.verdicts[0].verdict, "neutral");
});

test("越界 claimIndex 被丢掉（判定器越权不能凭空造断言）", () => {
  const claims = [claim("a")];
  const picked = pickJudged(claims, [verdict(7, "support", ["e1"]), verdict(-1, "support", ["e2"])]);
  assert.equal(picked.claims.length, 0);
  assert.equal(picked.verdicts.length, 0);
  assert.equal(picked.notJudged, 1);
});

test("空判定 → 全部未核；空断言 → 空结果", () => {
  const claims = [claim("a"), claim("b")];
  const none = pickJudged(claims, []);
  assert.equal(none.claims.length, 0);
  assert.equal(none.notJudged, 2);

  const empty = pickJudged([], [verdict(0, "support", ["e1"])]);
  assert.equal(empty.claims.length, 0);
  assert.equal(empty.notJudged, 0);
});
