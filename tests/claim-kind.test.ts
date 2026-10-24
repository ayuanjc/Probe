import { test } from "node:test";
import { strict as assert } from "node:assert";
import { ClaimSchema } from "../src/lib/schemas";
import {
  KIND_WEIGHTS,
  UNVERIFIABLE_KINDS,
  VERIFIABLE_KINDS,
  claimWeight,
  isVerifiableKind,
  weightOfKind,
} from "../src/lib/claim-kind";

test("权重表与 VERIFY-ARCH §1.2 一致", () => {
  assert.equal(KIND_WEIGHTS.quantitative, 1);
  assert.equal(KIND_WEIGHTS.temporal, 1);
  assert.equal(KIND_WEIGHTS.attribution, 0.9);
  assert.equal(KIND_WEIGHTS.existence, 0.8);
  assert.equal(KIND_WEIGHTS.causal, 0);
  assert.equal(KIND_WEIGHTS.opinion, 0);
  assert.equal(KIND_WEIGHTS.prediction, 0);
});

test("可核与不可核各三类，不能有落单的 kind", () => {
  assert.deepEqual(VERIFIABLE_KINDS.sort(), ["attribution", "existence", "quantitative", "temporal"]);
  assert.deepEqual(UNVERIFIABLE_KINDS.sort(), ["causal", "opinion", "prediction"]);
  assert.equal(VERIFIABLE_KINDS.length + UNVERIFIABLE_KINDS.length, 7);
});

test("脏字符串按不可核处理，不抛", () => {
  assert.equal(isVerifiableKind("quantitative"), true);
  assert.equal(isVerifiableKind("existence"), true);
  // 模型偶尔会发明类型名：宁可当不可核，也不能当 0.8 记进分母
  assert.equal(isVerifiableKind("fact"), false);
  assert.equal(isVerifiableKind(""), false);
  assert.equal(weightOfKind("fact" as never), 0);
});

test("Claim 缺 kind 时落到 existence（0.8），不是不可核", () => {
  // 兜底方向是故意的：误判成可核只是多一次检索，误判成不可核会把能核的说法踢出统计。
  const c = ClaimSchema.parse({ attr: "a", value: "v", quote: "q", sourceIds: ["s1"] });
  assert.equal(c.kind, "existence");
  assert.equal(claimWeight(c), 0.8);
});

test("Claim 保留显式 kind，并拒绝表外的值", () => {
  const c = ClaimSchema.parse({ attr: "a", value: "v", quote: "q", sourceIds: ["s1"], kind: "prediction" });
  assert.equal(c.kind, "prediction");
  assert.equal(claimWeight(c), 0);
  assert.equal(
    ClaimSchema.safeParse({ attr: "a", value: "v", quote: "q", sourceIds: ["s1"], kind: "rumour" }).success,
    false,
  );
});
