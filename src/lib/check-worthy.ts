import type { Claim } from "./schemas";

/**
 * 断言的前置筛选（文档 §6 成本控制第 1 条）：先判断"这条值不值得去核"。
 *
 * 为什么要这一步：核一条断言要一次留出集检索 + 一次判定调用。一份 300 行的文档
 * 能抽出 60 条断言，全核就是 120 次上游调用，跑三份文档够烧掉一天额度 ——
 * 而其中大半是「公司表示将加大投入」这类无法被任何外部证据支持或反驳的叙述。
 * 它们不是"假"，是**不可核**：核验它们只会得到一堆 silent，把吻合度分母撑大、
 * 把分数拖向 0.5，最后报告说得比实际知道的更少。
 */

/** 低于这个分数不进检索、不进模型。0.4 = 至少有一项硬信号（数字/日期/专名）。 */
export const CHECK_WORTHY_THRESHOLD = 0.4;

/**
 * 一次核验的量级成本（prompt + 检索结果 + 判定输出，tokens）。
 * 这是给"省了多少"用的粗估，不参与任何打分 —— 说清楚比精确更重要，
 * 900 这个数来自 6 条证据 × 约 120 tokens + 指令与输出。
 */
export const EVIDENCE_TOKENS_PER_CLAIM = 900;

/** 模糊表述：没有数字时几乎无法与外部证据对上（"大幅增长" vs "增长 37%"）。 */
const VAGUE = /显著|明显|大幅|小幅|较好|不错|较为|有所|一些|若干|许多|很多|可能|或将|普遍|整体上|相对|比较|趋于|向好|走强|承压/;

/** 数字：可被独立检索命中的最强信号。全角数字一起收，中文材料里不少见。 */
const NUMERIC = /[0-9０-９]/;

/** 时间锚点：同名事件靠日期区分，带日期的断言核验收益最高。 */
const DATED = /\b(19|20)\d{2}\b|\d{1,2}月\d{1,2}日|\d{4}-\d{2}-\d{2}/;

/** 可命名的具体主体：英文词或中文专名。纯虚词短语不该被当成实体。 */
const NAMED = /[A-Za-z]{2,}|[\u4e00-\u9fa5]{2,}/;

export type WorthInput = Pick<Claim, "attr" | "value" | "quote"> & { unit?: string };

/**
 * checkWorthy ∈ [0,1]，五项相加后截断：
 *
 *   +0.15 基础 —— 有逐字原文就等于"这条确实被说过"，值得看一眼
 *   +0.30 含数字 —— 数字能被别家独立报道对上，是全套指标里唯一硬信号
 *   +0.15 含日期 —— 再叠一层锚点
 *   +0.25 / +0.15 引文长度 —— 太短的引文必然断章，核验会得到大量边缘判定
 *   +0.15 含具体主体 —— 但要同时够短：值越长越像叙述，越不像事实点
 *   -0.35 模糊且无数字 —— 这类断言无法被证伪，核它就是白烧 token
 *
 * 阈值 0.4 的含义因此很具体：至少命中一项硬信号。
 *   {value: "$3.2B", quote: 20 字}      → 0.60 保留
 *   {value: "黄仁勋", quote: 30 字}      → 0.45 保留（换了 CEO 是可核事实）
 *   {value: "公司表示将加大在华投资力度"} → 0.30 跳过（叙述，不是事实点）
 *   {value: "显著提升", quote: 8 字}      → 0.00 跳过（不可证伪）
 */
export function checkWorthy(claim: WorthInput): number {
  const value = (claim.value ?? "").trim();
  const quote = (claim.quote ?? "").trim();
  let score = 0.15;

  const hasNumber = NUMERIC.test(value);
  if (hasNumber) score += 0.3;
  if (DATED.test(value)) score += 0.15;

  if (quote.length >= 40) score += 0.25;
  else if (quote.length >= 12) score += 0.15;

  // 长度上限是这里唯一"主观"的常数：事实点很短（人名、型号、金额），
  // 一旦值写成一句话，它说的就是态度而不是事实，核验只会拿到 silent。
  if (value.length <= 12 && NAMED.test(value)) score += 0.15;

  // 有数字的"大幅增长 120%"仍然可核：数字能对上，措辞不影响判定。
  if (VAGUE.test(value) && !hasNumber) score -= 0.35;

  const clamped = score < 0 ? 0 : score > 1 ? 1 : score;
  // 先舍入：0.15 + 0.3 在二进制里是 0.44999999999999996，
  // 直接拿去和阈值/界面上的「0.45」比会莫名其妙地差一点。
  return Number(clamped.toFixed(4));
}

export type ScoredClaim = {
  claim: Claim;
  /** 在原数组里的下标 —— 判定结果要按它回填，不能按对象引用。 */
  index: number;
  score: number;
};

export type GateResult = {
  kept: ScoredClaim[];
  skipped: ScoredClaim[];
  /** 跳过条数 × 单条核验成本。给 metrics 面板一个可对账的量级。 */
  savedCalls: number;
  savedTokens: number;
};

/**
 * 前置过滤。返回保留下来的断言、被跳过的断言（**不是丢掉**：
 * 报告里要能回答"为什么这条没核"，所以 skipped 必须原样带回）。
 */
export function selectVerifiable(
  claims: readonly Claim[],
  threshold = CHECK_WORTHY_THRESHOLD,
): GateResult {
  const kept: ScoredClaim[] = [];
  const skipped: ScoredClaim[] = [];
  claims.forEach((claim, index) => {
    const score = checkWorthy(claim);
    const entry = { claim, index, score };
    if (score >= threshold) kept.push(entry);
    else skipped.push(entry);
  });
  // 稳定排序：同分时保持原文顺序，否则同样的输入两次跑出不同的判定队列。
  kept.sort((a, b) => (b.score === a.score ? a.index - b.index : b.score - a.score));
  return {
    kept,
    skipped,
    savedCalls: skipped.length,
    savedTokens: skipped.length * EVIDENCE_TOKENS_PER_CLAIM,
  };
}
