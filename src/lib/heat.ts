
import type { HeatStatus } from "./schemas";

/**
 * 热度公式（PRD 2.3 V1.1）。原式 ${Mag + Dev × decay} 有两个硬缺陷：
 *   1. Mag（无上界的文章量）与 Dev（0~3 量级的 z-score）量纲不同，不能相加；
 *   2. 衰减只作用在 Dev 上，等于量级不衰减 —— 历史热点会永久霸榜。
 * 因此：两项各自分位归一 → 同量纲加权 → 衰减作用于整体。
 */

export const DECAY_TAU_HOURS = 36;

export function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** 中位绝对偏差：比标准差抗离群，适合日文章量这种尖峰序列。 */
export function mad(xs: number[]): number {
  if (xs.length === 0) return 0;
  const m = median(xs);
  return median(xs.map((x) => Math.abs(x - m)));
}

/** 经验分位（0~1）：value 在 series 中的百分位。 */
export function percentileRank(value: number, series: number[]): number {
  if (series.length === 0) return 0;
  let below = 0;
  for (const x of series) if (x <= value) below++;
  return below / series.length;
}

/** Mag = log1p(articles_24h)：压缩量纲。 */
export function magnitude(articles24h: number): number {
  return Math.log1p(Math.max(0, articles24h));
}

/** Dev = (x - median_30d) / (MAD_30d + eps)：稳健 z-score。 */
export function deviance(articles24h: number, median30d: number, mad30d: number): number {
  return (articles24h - median30d) / (mad30d + 1e-6);
}

export function decayFactor(ageHours: number, tau = DECAY_TAU_HOURS): number {
  return Math.exp(-Math.max(0, ageHours) / tau);
}

export type HeatInput = {
  articles24h: number;
  median30d: number;
  mad30d: number;
  /** 该 topic 的 log1p 值在 90 天每日序列里的分位。 */
  magPercentile: number;
  /** 该 topic 的 dev 值在 90 天每日序列里的分位。 */
  devPercentile: number;
  /** 最近一篇文章距今小时数。 */
  ageHours: number;
};

export function heatScore(input: HeatInput): number {
  const raw = 0.6 * input.magPercentile + 0.4 * input.devPercentile;
  return Number((raw * decayFactor(input.ageHours)).toFixed(4));
}

/* ------------------------------------------------------------------ *
 * 状态标签（阈值写死，供 Cron 与验收共用，PRD 2.3）
 * ------------------------------------------------------------------ */

export type StatusContext = {
  articles24h: number;
  median30d: number;
  /** 90 天日文章量的 P95。 */
  p95Articles: number;
  /** 是否曾进入过爆发期。 */
  wasBurst: boolean;
  /** 已处于 [1.0, 2.0] 区间的连续天数。 */
  hotDays: number;
};

export function ratio7d(articles24h: number, median30d: number): number {
  if (median30d <= 0) return articles24h > 0 ? 99 : 0;
  return articles24h / median30d;
}

export function statusLabel(ctx: StatusContext): HeatStatus {
  const r7 = ratio7d(ctx.articles24h, ctx.median30d);

  if (ctx.wasBurst && r7 >= 1 && r7 <= 2 && ctx.hotDays >= 5) return "long-tail";
  if (r7 > 2 && ctx.articles24h >= ctx.p95Articles) return "burst";
  if (r7 > 1.3) return "rising";
  if (r7 >= 0.8) return "stable";
  return "decaying";
}

export function statusLabelText(status: HeatStatus): string {
  switch (status) {
    case "burst":
      return "爆发期";
    case "rising":
      return "升温期";
    case "stable":
      return "平稳期";
    case "decaying":
      return "回落期";
    case "long-tail":
      return "长尾期";
  }
}

/**
 * 争议态（正交标签）：不是“情感方差大”，而是“信源在价值判断上分裂”。
 * 负向 owner 占比落在 [0.30, 0.70] 且独立 owner >= 5。
 */
export function isControversial(negativeOwners: number, totalOwners: number): boolean {
  if (totalOwners < 5) return false;
  const ratio = negativeOwners / totalOwners;
  return ratio >= 0.3 && ratio <= 0.7;
}

/** GDELT tone 三档：> 2 正，|tone| <= 2 中，< -2 负。 */
export function toneBucket(tone: number): "positive" | "neutral" | "negative" {
  if (tone > 2) return "positive";
  if (tone < -2) return "negative";
  return "neutral";
}
