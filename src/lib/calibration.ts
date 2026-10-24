import type { Interval } from "./agreement";

/**
 * 校准：分数说了 0.8，就真的该有八成是对的。
 *
 * 没有这一层的置信度只是装饰 —— 它是个 0~1 的数，谁也不知道 0.8 意味着什么。
 * 这里只做度量（ECE / MCE / Brier / 保形分位数），不做学习：
 * 拟合（ isotonic / Platt ）需要的样本量比一个看板能攒到的多得多，
 * 先能量出来「偏了多少、往哪偏」，比先拟合一个过拟合的映射有用。
 *
 * 参考文献：Brier 1950；Murphy 1973（可靠性/分辨率分解）；Guo 2017 ICML（ECE 与温度缩放）；
 * Angelopoulos & Bates 2021 arXiv:2107.07511（保形预测的有限样本分位数）。
 */

export type CalibrationPair = { predicted: number; correct: boolean };

export type CalibrationBin = {
  low: number;
  high: number;
  count: number;
  /** 这一箱里预测值的均值。空箱为 0，且不参与 ECE。 */
  confidence: number;
  accuracy: number;
};

export type CalibrationResult = {
  /** 期望校准误差 = Σ (n_b / n) · |acc_b − conf_b|。样本少时它一定偏乐观，要看 n。 */
  ece: number;
  /** 最大校准误差：最糟的那一箱偏了多少。比 ECE 更容易被单个箱带偏，所以只做辅助。 */
  mce: number;
  brier: number;
  n: number;
  bins: CalibrationBin[];
};

/** 分析文档 §7 的验收线：ECE 不超过 0.10 才算这个分数可用。 */
export const ECE_BUDGET = 0.1;

function usable(p: CalibrationPair): boolean {
  return Number.isFinite(p.predicted) && p.predicted >= 0 && p.predicted <= 1;
}

/**
 * 等宽分箱的可靠性表。
 *
 * 用等宽而不是等频，是因为界面要显示「报 0.9 的那批实际对了几成」——
 * 等频箱的边界每次随数据变，读的人没法把两次结果对上。
 */
export function calibrationBins(
  pairs: readonly CalibrationPair[],
  binCount = 10,
): CalibrationBin[] {
  const k = Math.max(1, Math.floor(binCount));
  const sums = new Array<number>(k).fill(0);
  const hits = new Array<number>(k).fill(0);
  const counts = new Array<number>(k).fill(0);

  for (const pair of pairs) {
    if (!usable(pair)) continue;
    const idx = Math.min(k - 1, Math.floor(pair.predicted * k));
    counts[idx] += 1;
    sums[idx] += pair.predicted;
    if (pair.correct) hits[idx] += 1;
  }

  const bins: CalibrationBin[] = [];
  for (let i = 0; i < k; i += 1) {
    const count = counts[i];
    bins.push({
      low: i / k,
      high: (i + 1) / k,
      count,
      confidence: count > 0 ? sums[i] / count : 0,
      accuracy: count > 0 ? hits[i] / count : 0,
    });
  }
  return bins;
}

/** 一份完整读数。没有可用样本时返回 null —— 不返回 0（0 会被读成「完美校准」）。 */
export function calibrationReport(
  pairs: readonly CalibrationPair[],
  binCount = 10,
): CalibrationResult | null {
  const valid = pairs.filter(usable);
  const n = valid.length;
  if (n === 0) return null;

  const bins = calibrationBins(valid, binCount);
  let ece = 0;
  let mce = 0;
  let brier = 0;

  for (const bin of bins) {
    if (bin.count === 0) continue;
    const gap = Math.abs(bin.accuracy - bin.confidence);
    ece += (bin.count / n) * gap;
    if (gap > mce) mce = gap;
  }

  for (const pair of valid) {
    const y = pair.correct ? 1 : 0;
    brier += (pair.predicted - y) ** 2;
  }

  return { ece, mce, brier: brier / n, n, bins };
}

export type CalibrationVerdict = "ok" | "warn" | "bad" | "unknown";

/**
 * 三档判定。unknown 的用途是「样本太少，别下结论」——
 * 20 条样本算出来的 ECE 精度约等于噪声，界面必须能说出这一点。
 */
export function calibrationVerdict(report: CalibrationResult | null, minSamples = 50): CalibrationVerdict {
  if (!report) return "unknown";
  if (report.n < minSamples) return "unknown";
  if (report.ece <= ECE_BUDGET) return "ok";
  if (report.ece <= ECE_BUDGET * 2) return "warn";
  return "bad";
}

export const CALIBRATION_LABEL: Record<CalibrationVerdict, string> = {
  ok: "校准可接受",
  warn: "校准偏移",
  bad: "校准不可用",
  unknown: "样本不足，暂不判定",
};

/**
 * 保形预测的单侧分位数（Angelopoulos & Bates 2021 的有限样本修正）。
 *
 * k = ceil((n + 1)(1 − alpha))；k > n 表示「用这点样本给不出这个置信水平」——
 * 返回 null 而不是最大分数。返回最大分数会让区间看起来合法，但覆盖率的保证已经没了，
 * 而这正是保形预测唯一值钱的地方。
 */
export function conformalQuantile(scores: readonly number[], alpha: number): number | null {
  if (!(alpha > 0 && alpha < 1)) return null;
  const clean = scores.filter((s) => Number.isFinite(s)).slice().sort((a, b) => a - b);
  const n = clean.length;
  if (n === 0) return null;
  const k = Math.ceil((n + 1) * (1 - alpha));
  if (k > n) return null;
  return clean[k - 1];
}

/** 把保形分位数包成区间：point ± q。用于给单个断言一个「可能范围」。 */
export function conformalInterval(
  point: number,
  scores: readonly number[],
  alpha: number,
): Interval | null {
  const q = conformalQuantile(scores, alpha);
  if (q === null || !Number.isFinite(point)) return null;
  return { low: point - q, high: point + q };
}
