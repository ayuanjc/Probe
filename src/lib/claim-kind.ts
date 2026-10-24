/**
 * 断言类型取值表（kind）—— 判定权重与「能不能核」的唯一来源。
 *
 * 为什么需要 kind：一条断言的「真伪」不是一个数，能核的程度本身分层。
 * 因果（A 导致 B）、观点（显著改善）、预测（明年将达 X）无法用检索到的证据判定，
 * 强行判只会拿到一堆「没找到证据」，把吻合度分母撑大、把分数压低 ——
 * 那时低分说明不了「文章有问题」，只说明「我们核不了」。所以：
 *
 *   · 四类可核断言进判定，按 kind 加权（VERIFY-ARCH §1.2）；
 *   · 三类不可核断言不进判定，只进「可核验率 coverage」的分母。
 *
 * 权重写死在代码里而不是放进配置：它决定分子与分母，改一个数会让所有历史分数失效。
 *
 * | kind         | 能核 | 权重 | 判据（抽取时按此分类）                     | 例                             |
 * |--------------|------|------|--------------------------------------------|--------------------------------|
 * | quantitative | 是   | 1.0  | 数字 + 单位/比率/金额/份额/排名/增幅        | 「数据中心收入 32 亿美元」      |
 * | temporal     | 是   | 1.0  | 日期、时点、期限、先后、持续时长            | 「2026-10-24 生效」             |
 * | attribution  | 是   | 0.9  | 谁说了 / 谁做的 / 谁拥有 / 谁任命           | 「黄仁勋表示…」「由 NVIDIA 收购」|
 * | existence    | 是   | 0.8  | 存在、上线、下架、具备某功能；无数字无时点   | 「该模型支持图像输入」          |
 * | causal       | 否   | 0    | 因果连接词：导致 / 因为 / 推动 / 带动 / 使得 | 「涨价导致需求下滑」            |
 * | opinion      | 否   | 0    | 评价或模糊程度：显著 / 看好 / 糟糕 / 值得    | 「表现显著优于同行」            |
 * | prediction   | 否   | 0    | 未来指向：将 / 预计 / 有望 / 计划 / 目标     | 「2027 年出货量翻倍」           |
 *
 * 分类优先序（一条断言同时符合多个时取**第一个命中**的）：
 *   prediction > causal > opinion > quantitative > temporal > attribution > existence
 *
 * 理由：「明年营收将达 500 亿」带数字但不可核，按数字去核它永远只会返回中性；
 * 「涨价导致毛利下降 3 个点」带数字但属于因果推断，证据最多给出相关，给不出因果。
 *
 * 0.9 与 0.8 不是精度，是**可核性折扣**：归属类断言的证据常常只有转述，
 * 存在性断言往往只能找到「有」而找不到「没有」——两类都天然缺一侧。
 */

import type { ClaimKind } from "./schemas";

/**
 * 权重表。类型是 Record<ClaimKind, number>：schemas.ts 里新增一个 kind 而不在这里补权重，
 * 会直接编译失败，而不是运行时静默按 0 处理。
 */
export const KIND_WEIGHTS: Record<ClaimKind, number> = {
  quantitative: 1,
  temporal: 1,
  attribution: 0.9,
  existence: 0.8,
  causal: 0,
  opinion: 0,
  prediction: 0,
};

/** 模型没给 kind 时的兜底值，与 ClaimSchema 的 default 必须一致。 */
export const DEFAULT_CLAIM_KIND: ClaimKind = "existence";

/**
 * 不可核断言的统一理由。
 *
 * 放在这里而不是 verify.ts，是因为 dossier.ts 也要用它给未核验的行写理由 ——
 * 两处各写一份的结果一定是界面上一半「不可核验」一半「不参与统计」，
 * 用户会以为这是两种不同的问题。
 */
export const UNVERIFIABLE_REASON =
  "不可核验：因果 / 观点 / 预测类断言，不参与吻合度的分子与分母（只计入可核验率）。";

export function weightOfKind(kind: ClaimKind): number {
  return KIND_WEIGHTS[kind] ?? 0;
}

/** 只对四类可核断言返回 true。传进来的可能是脏字符串，所以按表查而不是按枚举比。 */
export function isVerifiableKind(kind: string): boolean {
  return weightOfKind(kind as ClaimKind) > 0;
}

/** 断言在吻合度分子/分母里的权重；不可核一律 0（调用方应先用 isVerifiableKind 分流）。 */
export function claimWeight(claim: { kind: ClaimKind }): number {
  return weightOfKind(claim.kind);
}

export const VERIFIABLE_KINDS = (Object.keys(KIND_WEIGHTS) as ClaimKind[]).filter(
  (k) => KIND_WEIGHTS[k] > 0,
);

export const UNVERIFIABLE_KINDS = (Object.keys(KIND_WEIGHTS) as ClaimKind[]).filter(
  (k) => KIND_WEIGHTS[k] === 0,
);
