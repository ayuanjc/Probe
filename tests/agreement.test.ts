import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
  DOSSIER_VISIBLE_FIELDS,
  buildDossierView,
  effectiveSampleSize,
  fleissKappa,
  gwetAc1,
  ownerWeights,
  weightedAgreement,
  wilsonFromProportion,
  wilsonInterval,
} from "../src/lib/agreement";

function close(actual: number, expected: number, eps = 1e-3, label = "value"): void {
  assert.ok(
    Math.abs(actual - expected) <= eps,
    label + ": 期望 " + expected + " ±" + eps + "，实际 " + actual,
  );
}

test("effectiveSampleSize：全等权重时恰好等于票数", () => {
  assert.equal(effectiveSampleSize([1, 1, 1, 1, 1]), 5);
  assert.equal(effectiveSampleSize([]), 0);
});

test("effectiveSampleSize：降权票把有效票数拉下来（Kish）", () => {
  // (1+1+1+0.6+0.6)² / (1+1+1+0.36+0.36) = 17.64 / 3.72 = 4.7419
  close(effectiveSampleSize([1, 1, 1, 0.6, 0.6]), 17.64 / 3.72);
});

test("effectiveSampleSize：NaN 与负权重按 0 处理，不让整条链路变 NaN", () => {
  assert.equal(effectiveSampleSize([Number.NaN, -3, 1]), 1);
});

test("Wilson：38/41 的支持率不叫「板上钉钉」", () => {
  const iv = wilsonInterval(38, 41);
  close(iv.low, 0.8057, 2e-3, "low");
  close(iv.high, 0.9748, 2e-3, "high");
});

test("Wilson：3/3 的上界是 1，下界只有 0.44", () => {
  const iv = wilsonInterval(3, 3);
  close(iv.low, 0.4385, 2e-3, "low");
  assert.equal(iv.high, 1);
});

test("Wilson：没有样本时退回 0..1，而不是 0.5±0", () => {
  assert.deepEqual(wilsonInterval(0, 0), { low: 0, high: 1 });
  assert.deepEqual(wilsonFromProportion(0.8, 0), { low: 0, high: 1 });
});

test("按 n_eff 算区间：票少，区间就该宽", () => {
  const wide = wilsonFromProportion(0.79, 1.2);
  const narrow = wilsonFromProportion(0.79, 40);
  assert.ok(wide.high - wide.low > narrow.high - narrow.low, "n_eff=1.2 的区间应显著更宽");
  assert.ok(wide.low < 0.79 && wide.high > 0.79);
});

test("Fleiss κ：机会校正真的扣掉了随机一致", () => {
  // 2 条断言 × 4 判定者，两类：[[4,0],[2,2]]
  // P_o = (1 + 1/3) / 2 = 0.6667；P_e = 0.75² + 0.25² = 0.625；κ = 0.0417/0.375
  const k = fleissKappa([[4, 0], [2, 2]]);
  assert.ok(k !== null);
  close(k.pObserved, 2 / 3, 1e-9, "P_o");
  close(k.pExpected, 0.625, 1e-9, "P_e");
  close(k.kappa, 1 / 9, 1e-9, "κ");
});

test("Fleiss κ：P_e = 1（所有人只用同一类）时返回 null，不是「完美一致」", () => {
  assert.equal(fleissKappa([[4, 0], [4, 0]]), null);
});

test("Fleiss κ：矩阵形状不合法就返回 null，不放 NaN 进来", () => {
  // 每行必须被同样多的判定者打满：这里 4 与 3 不一致
  assert.equal(fleissKappa([[4, 0], [2, 1]]), null);
  // 非整数格子（小数票不是票）
  assert.equal(fleissKappa([[3.5, 0.5]]), null);
  // 只有一类：没有可比较的变异
  assert.equal(fleissKappa([[4], [4]]), null);
});

test("Gwet AC1：同一组数据里比 κ 宽松，差值来自 P_e 的口径", () => {
  const a = gwetAc1([[4, 0], [2, 2]], 2);
  assert.ok(a !== null);
  close(a.pObserved, 2 / 3, 1e-9, "P_o");
  close(a.pExpected, 0.375, 1e-9, "AC1 的 P_e");
  close(a.ac1, 0.466667, 1e-5, "AC1");
  const k = fleissKappa([[4, 0], [2, 2]]);
  assert.ok(k !== null && a.ac1 > k.kappa, "类别偏斜时 AC1 应高于 κ");
});

test("weightedAgreement：朴素 0.833 vs 有效 0.795，差 0.038（文档 §3.3 那组）", () => {
  const b = weightedAgreement([1, 1, 0.3, 0.3, 0.5], [0.8]);
  close(b.naive, 5 / 6, 1e-9, "naive");
  close(b.weighted, 3.1 / 3.9, 1e-9, "weighted");
  close(b.premium, 5 / 6 - 3.1 / 3.9, 1e-9, "premium");
  assert.equal(b.nSupport, 5);
  assert.equal(b.nContra, 1);
  assert.equal(b.n, 6);
});

test("weightedAgreement：一票没有时两个比例都中性，但 n = 0 必须被调用方看见", () => {
  const b = weightedAgreement([], []);
  assert.equal(b.n, 0);
  assert.equal(b.naive, 0.5);
  assert.equal(b.weighted, 0.5);
  assert.equal(b.premium, 0);
});

test("buildDossierView：有证据时给主数字 + Wilson 区间", () => {
  const v = buildDossierView({
    support: [1, 1, 0.3, 0.3, 0.5],
    contradict: [0.8],
    nEff: 4.742,
    kappa: 0.25,
    kappaExpected: 0.5556,
    ac1: 0.4,
    nChecked: 6,
    nSilent: 2,
    coverage: 0.5,
  });
  assert.ok(v.agreement !== null);
  close(v.agreement.value, 3.1 / 3.9, 1e-9, "agreement");
  assert.ok(v.agreement.low < v.agreement.value && v.agreement.high > v.agreement.value);
  assert.equal(v.agreement.n, 6);
  assert.ok(v.fakeConsensus !== null);
  close(v.fakeConsensus.premium, 5 / 6 - 3.1 / 3.9, 1e-9, "溢价");
  assert.equal(v.tooltip.kappa, 0.25);
  assert.equal(v.tooltip.ac1, 0.4);
  assert.equal(v.tooltip.nSilent, 2);
  assert.equal(v.tooltip.nChecked, 6);
  assert.equal(v.tooltip.coverage, 0.5);
});

test("buildDossierView：没有核验证据时 agreement 必须是 null，不许回落 0.5", () => {
  const v = buildDossierView({ support: [], contradict: [], nEff: 0 });
  assert.equal(v.agreement, null);
  assert.equal(v.fakeConsensus, null);
  assert.equal(v.nEff, 0);
  assert.equal(v.tooltip.naive, 0.5);
});

test("buildDossierView：只有赞成票时不点亮假共识（没有反对票就没有「溢价」）", () => {
  const v = buildDossierView({ support: [1, 1, 0.3, 0.3], contradict: [], nEff: 2.5 });
  assert.equal(v.fakeConsensus, null);
  assert.ok(v.agreement !== null);
  assert.equal(v.agreement.value, 1);
});

test("ownerWeights：一个 owner 一票，取它最强的那条", () => {
  const m = new Map<string, { firsthand: boolean }[]>([
    ["a.example", [{ firsthand: false }, { firsthand: true }]],
    ["b.example", [{ firsthand: false }]],
  ]);
  const { weights, distributors } = ownerWeights(m);
  assert.deepEqual(weights, [1, 0.3]);
  assert.deepEqual(distributors, ["b.example"]);
});

test("UI 契约：卡片上只能出现三个字段", () => {
  assert.deepEqual([...DOSSIER_VISIBLE_FIELDS], ["agreement", "nEff", "fakeConsensus"]);
});
