/**
 * 查询里有没有「明确的时间约束」。
 *
 * 为什么需要区分：意图里永远带一个 timeRange —— 用户什么都没说时默认 30 天。
 * 于是「有时间窗」这件事不能看 timeRange 是否存在，只能看用户有没有真的说过。
 *
 * 用途：Tavily 的 general 检索不回发布日期（0/15），只有 topic=news 才回（10/10）。
 * 多打一次的代价是检索成本翻倍，所以只在用户自己圈了时间范围时才加这一次 ——
 * 他要的是「最近三个月发生了什么」，那就得知道每条是什么时候的。
 *
 * 宁可漏判（少打一次 news，退回「部分日期未知」），也不要误判：误判等于每轮多花钱。
 * 所以只认明确的时间词，不认「最近」这类没有刻度的说法。
 */

/** 有刻度的相对时间词。「最近」不在内：它没说是多近。 */
const RELATIVE =
  /今天|今日|昨天|昨日|本周|这周|上周|一周|本月|这个月|上月|上个月|近三月|三个月|季度|近半年|半年|近一年|过去一年|一年|今年|去年|前年|近\s*\d+\s*(天|日|周|个月|年)|\d+\s*(天|周|个月|年)前|today|yesterday|this week|last week|this month|last month|this year|last year|past (week|month|year)|last \d+ (day|week|month|year)s?|\d+ (day|week|month|year)s? ago/i;

/** 明确写出来的年月日：2026年、2026-10、10月24日、Q3 这类。 */
const ABSOLUTE =
  /(19|20)\d{2}\s*年|(19|20)\d{2}-\d{1,2}(-\d{1,2})?|(19|20)\d{2}\/\d{1,2}|\d{1,2}\s*月\s*\d{1,2}\s*日|\d{1,2}\s*月(份)?|Q[1-4]\b|第[一二三四]季度/i;

export function hasExplicitTimeWindow(query: string): boolean {
  if (!query) return false;
  return RELATIVE.test(query) || ABSOLUTE.test(query);
}