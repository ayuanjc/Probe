/**
 * 上游失败分类。裸的 "tavily:failed" 在界面上和 "bocha:failed" 同义，
 * 但「账号没余额」「被限流」「key 不对」「网络超时」是四种完全不同的下一步：
 * 充值、等、换 key、重试。混成一个词，用户只能全试一遍。
 */

export type FailureKind = "quota" | "rate_limited" | "auth" | "timeout" | "failed";

/** 额度类措辞：博查 403 的原文是「You do not have enough money or package quota」。 */
const QUOTA_HINT = /quota|balance|credit|money|insufficient|额度|余额|套餐/i;

export function classifyFailure(err: unknown): FailureKind {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  const status = /\bhttp (\d{3})\b/.exec(msg);
  const code = status ? Number(status[1]) : 0;

  if (/timeout|timed out|aborted|ETIMEDOUT|ECONNRESET|ENOTFOUND|EAI_AGAIN/i.test(msg)) return "timeout";
  if (code === 402) return "quota";
  if (code === 403) return QUOTA_HINT.test(msg) ? "quota" : "auth";
  // Tavily 用 432/433 表示套餐用量，博查用 402/403；一起收进额度类。
  if (code === 432 || code === 433) return "quota";
  if (code === 429) return "rate_limited";
  if (code === 401) return "auth";
  if (QUOTA_HINT.test(msg)) return "quota";
  return "failed";
}

export function failureCode(provider: string, err: unknown): string {
  return provider + ":" + classifyFailure(err);
}

/** 这些是「再试也一样」的失败，界面上不该建议重试。 */
export function isTerminalFailure(kind: FailureKind): boolean {
  return kind === "quota" || kind === "auth";
}