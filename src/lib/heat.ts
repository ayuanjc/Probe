
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

/**
 * Dev = (x - median_30d) / (MAD_30d + eps)：稳健 z-score。
 *
 * eps 只用来挡住「MAD 正好是 0」这一种情况（半个月每天条数一模一样）。
 * 它会把那种情况下的偏离放大成一个很大但有限的值，交给后面的分位排名处理 ——
 * 分母为 0 得到 Infinity 会让整条百分位链变成 NaN。
 */
export function deviance(articles24h: number, median30d: number, mad30d: number): number {
  return (articles24h - median30d) / (mad30d + 1e-6);
}

/**
 * r7 的上限。基线为 0（30 天里这个话题几乎没被提过）时比值没有意义，
 * 早期版本返回 99 当哨兵，结果这个数字直接显示在卡片上、也写进 tooltip。
 * 现在截到 9.99：仍然稳稳落在「爆发」区间，但不会有人看到 99 以为是条数。
 */
export const RATIO_CAP = 9.99;

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
  if (median30d <= 0) return articles24h > 0 ? RATIO_CAP : 0;
  return Math.min(RATIO_CAP, articles24h / median30d);
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

/* ------------------------------------------------------------------ *
 * 从日序列到状态（PRD 2.3 的可计算版本）
 *
 * 上面那套 ratio7d(articles24h, median30d) 只能回答「今天 vs 平时」，
 * 而 PRD 的 r7 是「近 7 日均值 / 前 30 日均值」—— 一天的尖峰不该被当成
 * 一整周的趋势。有了 heat-history 的日序列，这里按原式算，不再用 24h 代替 7 天。
 * ------------------------------------------------------------------ */

export type SeriesStats = {
  /** 参与统计的天数（不含今天） */
  days: number;
  /** 近 7 日均值（序列末 7 天） */
  mean7: number;
  /** 前 30 日均值 */
  mean30: number;
  /** 前 30 日中位数 —— Dev 的分母基准 */
  median30: number;
  /** 前 30 日中位绝对偏差 */
  mad30: number;
  /** 序列 P95 —— 「爆发」要求今天的量落在历史高位 */
  p95: number;
  /** r7 = mean7 / mean30；mean30 为 0 时退化成「有没有」 */
  r7: number;
  /** 日量 / 中位数连续落在 [1, 2] 的天数（长尾判据用） */
  hotDays: number;
  /** 序列里出现过爆发日（>= p95 且 /中位数 > 2） */
  wasBurst: boolean;
};

function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((s, x) => s + x, 0) / xs.length;
}

export function quantile(xs: number[], q: number): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const at = Math.min(s.length - 1, Math.max(0, Math.round((s.length - 1) * q)));
  return s[at];
}

/**
 * @param series 按日期升序的日计数，**不含今天**（今天由实时快照提供）。
 *   少于 14 天时返回 null：两周不到的日子算不出「平时是什么样」，
 *   这时候硬给状态标签就是在猜。
 */
export function seriesStats(series: number[]): SeriesStats | null {
  if (series.length < 14) return null;
  const last30 = series.slice(-30);
  const last7 = series.slice(-7);
  const median30 = median(last30);
  const mad30 = mad(last30);
  const p95 = quantile(last30, 0.95);
  const mean30 = mean(last30);
  const r7 =
    mean30 <= 0 ? (mean(last7) > 0 ? RATIO_CAP : 0) : Math.min(RATIO_CAP, mean(last7) / mean30);

  // 「日量是平时的 1~2 倍」连续多少天：从序列末尾往前数，遇到不满足就停。
  let hotDays = 0;
  if (median30 > 0) {
    for (let i = last30.length - 1; i >= 0; i--) {
      const ratio = last30[i] / median30;
      if (ratio < 1 || ratio > 2) break;
      hotDays++;
    }
  }
  const wasBurst = median30 > 0 && last30.some((x) => x >= p95 && x / median30 > 2);
  return { days: series.length, mean7: mean(last7), mean30, median30, mad30, p95, r7, hotDays, wasBurst };
}

/** 今天的量在历史序列里的两个分位（PRD 的 pct90 归一化就靠它）。 */
export function todayPercentiles(series: number[], today: number): { mag: number; dev: number } {
  if (series.length === 0) return { mag: 0, dev: 0 };
  const m = median(series);
  const d = mad(series);
  const mags = series.map((x) => magnitude(x));
  const devs = series.map((x) => deviance(x, m, d));
  return {
    mag: percentileRank(magnitude(today), mags),
    dev: percentileRank(deviance(today, m, d), devs),
  };
}

/**
 * 状态标签。判据与阈值逐条对齐 PRD 2.3，顺序即优先级：
 * 长尾要先判 —— 它描述的是「曾经爆发过、现在还在骨架里」，会被 r7 ∈ [1,2] 同时满足升温/平稳。
 */
export function statusFromSeries(stats: SeriesStats, articles24h: number): HeatStatus {
  const r7 = stats.r7;
  if (stats.wasBurst && r7 >= 1 && r7 <= 2 && stats.hotDays >= 5) return "long-tail";
  if (r7 > 2 && articles24h >= stats.p95) return "burst";
  if (r7 > 1.3) return "rising";
  if (r7 >= 0.8) return "stable";
  return "decaying";
}

/** 状态 → 一句话判据（给徽章的 tooltip 用，避免用户自己反推阈值）。 */
export function statusReason(status: HeatStatus, stats: SeriesStats, articles24h: number): string {
  const r7 = stats.r7.toFixed(2);
  switch (status) {
    case "burst":
      return "r7 " + r7 + " > 2，且今天 " + articles24h + " 条不低于历史 P95（" + stats.p95 + " 条）";
    case "rising":
      return "r7 " + r7 + " 落在 1.3 ~ 2 之间";
    case "stable":
      return "r7 " + r7 + " 落在 0.8 ~ 1.3 之间";
    case "decaying":
      return "r7 " + r7 + " < 0.8，比平时冷";
    case "long-tail":
      return "历史上爆发过，现在 r7 " + r7 + " 回到 1 ~ 2，已连续 " + stats.hotDays + " 天";
  }
}
