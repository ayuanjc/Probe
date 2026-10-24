import { test } from "node:test";
import { strict as assert } from "node:assert";
import { gradeOf, coverageOf, GRADE_ORDER, type GradeInput } from "../src/lib/grade";

function input(over: Partial<GradeInput> = {}): GradeInput {
  return {
    agreement: 0.9,
    judged: 8,
    contradicted: 0,
    verifiable: 8,
    unverifiable: 2,
    highAuthorityConflict: false,
    ...over,
  };
}

test("coverageOf：分母为 0 返回 null，不是 0", () => {
  assert.equal(coverageOf(0, 0), null);
  assert.equal(coverageOf(3, 1), 0.75);
});

test("没有判定就不发字母档", () => {
  const r = gradeOf(input({ agreement: null, judged: 0, verifiable: 0, unverifiable: 4 }));
  assert.equal(r.grade, "N/A");
  assert.equal(r.reason, "n/a:all_unverifiable");
});

test("全篇都是可核验断言但一条没核 → no_judged", () => {
  const r = gradeOf(input({ agreement: null, judged: 0, verifiable: 5, unverifiable: 0 }));
  assert.equal(r.grade, "N/A");
  assert.equal(r.reason, "n/a:no_judged");
});

test("覆盖率低于 0.25 不发字母档", () => {
  // 10 条里 8 条是观点，只剩 2 条能核 —— 这时候给 A 是在替作者背书
  const r = gradeOf(input({ agreement: 0.95, judged: 2, verifiable: 2, unverifiable: 9 }));
  assert.equal(r.grade, "N/A");
  assert.equal(r.reason, "n/a:low_coverage");
});

test("判定数不足 3 不发字母档", () => {
  const r = gradeOf(input({ agreement: 0.99, judged: 2, verifiable: 2, unverifiable: 0 }));
  assert.equal(r.grade, "N/A");
  assert.equal(r.reason, "n/a:too_few_judged");
});

test("A+ 要同时满足四条：0.85 / coverage 0.6 / 零矛盾 / 至少 8 条", () => {
  assert.equal(gradeOf(input({ agreement: 0.9, judged: 8, verifiable: 8, unverifiable: 2 })).grade, "A+");
  // 少一条矛盾也是矛盾
  assert.equal(gradeOf(input({ agreement: 0.9, judged: 8, contradicted: 1 })).grade, "A");
  // 覆盖率不够 0.6
  assert.equal(gradeOf(input({ agreement: 0.9, judged: 8, verifiable: 8, unverifiable: 6 })).grade, "A");
});

test("梯队边界按 0.75/0.65/0.55/0.4/0.25/0.1 分档", () => {
  const at = (a: number) => gradeOf(input({ agreement: a, judged: 8, contradicted: 0 })).grade;
  assert.equal(at(0.75), "A");
  assert.equal(at(0.74), "B+");
  assert.equal(at(0.65), "B+");
  assert.equal(at(0.64), "B");
  assert.equal(at(0.55), "B");
  assert.equal(at(0.54), "C+");
  assert.equal(at(0.4), "C+");
  assert.equal(at(0.39), "C");
  assert.equal(at(0.25), "C");
  assert.equal(at(0.24), "D");
  assert.equal(at(0.1), "D");
  assert.equal(at(0.09), "E");
});

test("高权威矛盾率过半 → 下限 F，高于上限 B", () => {
  // 这一条是「下限优先」的证据：agreement 0.95 也救不回来
  const r = gradeOf(input({ agreement: 0.95, judged: 6, contradicted: 3, highAuthorityConflict: true }));
  assert.equal(r.grade, "F");
  assert.equal(r.reason, "f:high_authority_conflict");
});

test("有权威反证但矛盾不过半 → 上限 B，并标明被压过", () => {
  const r = gradeOf(input({ agreement: 0.95, judged: 6, contradicted: 2, highAuthorityConflict: true }));
  assert.equal(r.grade, "B");
  assert.equal(r.capped, true);
  assert.equal(r.reason, "capped:high_authority_conflict");
});

test("已经低于 B 时不再假装被压过", () => {
  // 0.30 落在 C 档：权威反证存在，但评级本来就比 B 低，capped 必须留 false，
  // 否则界面会解释成「因为它才降的」，替一个没发生的事写因果。
  const r = gradeOf(input({ agreement: 0.3, judged: 6, contradicted: 0, highAuthorityConflict: true }));
  assert.equal(r.grade, "C");
  assert.equal(r.capped, false);
});

test("GRADE_ORDER 从高到低，且上限操作依赖它的顺序", () => {
  assert.deepEqual([...GRADE_ORDER], ["A+", "A", "B+", "B", "C+", "C", "D", "E", "F"]);
  assert.ok(GRADE_ORDER.indexOf("A+") < GRADE_ORDER.indexOf("B"));
});
