import type { HeatStatus } from "./schemas";

/**
 * 状态标签的中文与配色。
 *
 * 抽出来是因为现在有两条轨在用同一套标签（HN 前沿 / 中文科技前沿）：
 * 公式同一个（src/lib/heat.ts），标签就不该各写一份 —— 一处改文案，
 * 另一处没改，同一份数据在两个地方叫两个名字，读者第一个反应是「哪个准」。
 *
 * 配色规则：蓝色只给「要你看」的趋势（爆发 / 升温），其余中性灰。
 */
export const HEAT_STATUS_TEXT: Record<HeatStatus, string> = {
  burst: "爆发期",
  rising: "升温期",
  stable: "平稳期",
  decaying: "回落期",
  "long-tail": "长尾期",
};

export const HEAT_STATUS_CHIP: Record<HeatStatus, string> = {
  burst: "bg-blue-500/10 text-blue-400",
  rising: "bg-blue-500/10 text-blue-400",
  stable: "bg-neutral-800 text-neutral-400",
  decaying: "bg-neutral-800 text-neutral-500",
  "long-tail": "bg-neutral-800 text-neutral-400",
};

export const HEAT_STATUS_ORDER: HeatStatus[] = ["burst", "rising", "stable", "decaying", "long-tail"];
