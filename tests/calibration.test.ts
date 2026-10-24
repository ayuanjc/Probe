import test from "node:test";
import assert from "node:assert/strict";

import {
  CALIBRATION_LABEL,
  ECE_BUDGET,
  calibrationBins,
  calibrationReport,
  calibrationVerdict,
  conformalInterval,
  conformalQuantile,
} from "@/lib/calibration";

function pairs(predicted: number, total: number, correct: number) {
  return Array.from({ length: total }, (_, i) => ({ predicted, correct: i < correct }));
}

test("ECE：报 0.9 全对 + 报 0.3 全错 → 0.2，Brier 0.05", () => {
  const r = calibrationReport([...pairs(0.9, 10, 10), ...pairs(0.3, 10, 0)]);
  assert.ok(r);
  // |1 − 0.9| 与 |0 − 0.3| 各占一半 → (0.1 + 0.3) / 2 = 0.2
  assert.ok(Math.abs(r.ece - 0.2) < 1e-12);
  assert.ok(Math.abs(r.mce - 0.3) < 1e-12);
  assert.ok(Math.abs(r.brier - 0.05) < 1e-12);
  assert.equal(r.n, 20);
  assert.equal(calibrationVerdict(r), "unknown");
});

test("完美校准的批量数据 ECE 接近 0", () => {
  const data = [...pairs(0.5, 100, 50), ...pairs(0.9, 100, 90)];
  const r = calibrationReport(data);
  assert.ok(r);
  assert.ok(r.ece < 1e-12);
  assert.equal(calibrationVerdict(r), "ok");
});

test("空样本返回 null，不返回 0", () => {
  assert.equal(calibrationReport([]), null);
  assert.equal(calibrationVerdict(null), "unknown");
  assert.equal(calibrationReport([{ predicted: NaN, correct: true }]), null);
  assert.equal(calibrationReport([{ predicted: 1.4, correct: true }]), null);
});

test("分箱边界：0.99 落在最后一箱，0 落在第一箱，箱内均值算对", () => {
  const bins = calibrationBins([
    { predicted: 0, correct: false },
    { predicted: 0.99, correct: true },
    { predicted: 0.95, correct: false },
  ]);
  assert.equal(bins.length, 10);
  assert.equal(bins[0].count, 1);
  assert.equal(bins[0].accuracy, 0);
  assert.equal(bins[9].count, 2);
  assert.ok(Math.abs(bins[9].confidence - 0.97) < 1e-12);
  assert.equal(bins[9].accuracy, 0.5);
  // 空箱不参与 ECE：这里 ECE = 0.1·|0−0| ... 由 report 负责，bins 只报事实。
  assert.equal(bins[4].count, 0);
  assert.equal(bins[4].confidence, 0);
});

test("三档判定按 ECE_BUDGET 分界", () => {
  const make = (ece: number) => ({ ece, mce: ece, brier: 0.25, n: 100, bins: [] });
  assert.equal(calibrationVerdict(make(ECE_BUDGET)), "ok");
  assert.equal(calibrationVerdict(make(ECE_BUDGET * 1.5)), "warn");
  assert.equal(calibrationVerdict(make(ECE_BUDGET * 3)), "bad");
  assert.equal(calibrationVerdict(make(0)), "ok");
  assert.equal(calibrationVerdict(make(0), 1000), "unknown");
  assert.equal(CALIBRATION_LABEL.bad, "校准不可用");
});

test("保形分位数：k = ceil((n+1)(1−alpha))，样本不够给 null", () => {
  const s = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  // n=10, alpha=0.1 → k=ceil(11·0.9)=10 → 第 10 小的 10
  assert.equal(conformalQuantile(s, 0.1), 10);
  // n=5, alpha=0.4 → k=ceil(6·0.6)=4 → 4
  assert.equal(conformalQuantile([1, 2, 3, 4, 5], 0.4), 4);
  // n=5, alpha=0.1 → k=ceil(6·0.9)=6 > 5 → null（不是 5）
  assert.equal(conformalQuantile([1, 2, 3, 4, 5], 0.1), null);
  assert.equal(conformalQuantile([], 0.1), null);
  assert.equal(conformalQuantile([1, NaN, 2], 0.5), 2);
  assert.equal(conformalQuantile(s, 0), null);
  assert.equal(conformalQuantile(s, 1), null);
});

test("保形区间：point ± q，q 为 null 时整区间为 null", () => {
  // n=3, alpha=0.5 → k=ceil(4·0.5)=2 → q 取第 2 小的 0.2
  assert.deepEqual(conformalInterval(0.5, [0.1, 0.2, 0.3], 0.5), { low: 0.3, high: 0.7 });
  // alpha=0.34 → k=ceil(4·0.66)=3 → q=0.3
  assert.deepEqual(conformalInterval(0.5, [0.1, 0.2, 0.3], 0.34), { low: 0.2, high: 0.8 });
  assert.equal(conformalInterval(0.5, [0.1], 0.05), null);
  assert.equal(conformalInterval(NaN, [0.1, 0.2], 0.5), null);
});
