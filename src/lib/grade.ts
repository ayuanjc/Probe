/**
 * 评级：把四口径压成一个字母。纯函数，没有任何模型参与。
 *
 * 这张表是 VERIFY-ARCH §1.5 的代码版。三条设计意图，改动前先读：
 *
 *   1. 上限与下限并存。「高权威多源矛盾」在正向是**上限 B**（不许 A），
 *      在反向是**下限 F**（矛盾率过半时直接 F）。两者方向相反，不是笔误 ——
 *      被两份权威来源顶回来这个结论，不依赖覆盖率有多高。
 *   2. N/A 有三种，互相不能合并：没判过（no_judged）、判得太少（too_few_judged）、
 *      能核的太少（low_coverage）。界面上说法不同，用户要能分辨「没核」和「核不了」。
 *   3. 分母不足时不给字母。judged < 3 一样不发档 —— 一条证据命中就能拿 A 的评级，
 *      比没有评级更糟。
 */

export type Grade = "A+" | "A" | "B+" | "B" | "C+" | "C" | "D" | "E" | "F" | "N/A";

/** 从高到低。上限操作靠它算序，不靠 if 链。 */
export const GRADE_ORDER: readonly Grade[] = ["A+", "A", "B+", "B", "C+", "C", "D", "E", "F"];

export type GradeInput = {
  /** 加权吻合度点估计；null = 本轮没有做外部核验（不是 0，也不回落到 0.5）。 */
  agreement: number | null;
  /** 进了判定的断言数（supported + contradicted）。吻合度的分母。 */
  judged: number;
  /** 被判矛盾的断言数。 */
  contradicted: number;
  /** 可核验断言数（judged + unverified）。 */
  verifiable: number;
  /** 不可核验断言数（causal / opinion / prediction）。 */
  unverifiable: number;
  /** 是否存在「≥2 个独立 owner 且 authority ≥ 0.7」的矛盾。 */
  highAuthorityConflict: boolean;
};

export type GradeResult = {
  grade: Grade;
  /** 机器可读的理由码，界面翻译成人话；不写猜测。 */
  reason: string;
  /** 是否被「上限 B」压过 —— 界面要能说明「本来更高，但因为权威反证降了」。 */
  capped: boolean;
};

export const N_A_LABEL: Record<string, string> = {
  "n/a:no_judged": "本轮没有做外部核验",
  "n/a:too_few_judged": "判定的断言太少，不给定论",
  "n/a:low_coverage": "可核验内容太少，不给定论",
  "n/a:all_unverifiable": "全文都是观点与推断，没有可核验的断言",
};

export function coverageOf(verifiable: number, unverifiable: number): number | null {
  const total = verifiable + unverifiable;
  return total > 0 ? verifiable / total : null;
}

export function gradeOf(input: GradeInput): GradeResult {
  const judged = Math.max(0, input.judged);
  const contradicted = Math.max(0, Math.min(judged, input.contradicted));
  const conflictRate = judged > 0 ? contradicted / judged : 0;
  const coverage = coverageOf(input.verifiable, input.unverifiable);

  // 下限优先：矛盾率过半且有权威反证 → F。此时的结论不是「核得不准」，是「事实被否」。
  if (judged > 0 && input.highAuthorityConflict && conflictRate >= 0.5) {
    return { grade: "F", reason: "f:high_authority_conflict", capped: false };
  }

  if (input.agreement === null || judged === 0) {
    const reason = input.verifiable + input.unverifiable > 0 && input.unverifiable > 0 && input.verifiable === 0
      ? "n/a:all_unverifiable"
      : "n/a:no_judged";
    return { grade: "N/A", reason, capped: false };
  }

  if (coverage === null || coverage < 0.25) {
    return { grade: "N/A", reason: "n/a:low_coverage", capped: false };
  }

  // 一条证据命中就发 A，比不发档更糟 —— 样本不足时宁可说「不给定论」。
  if (judged < 3) {
    return { grade: "N/A", reason: "n/a:too_few_judged", capped: false };
  }

  const a = clamp01(input.agreement);
  let grade: Grade;
  if (a >= 0.85 && coverage >= 0.6 && conflictRate === 0 && judged >= 8) grade = "A+";
  else if (a >= 0.75 && coverage >= 0.5) grade = "A";
  else if (a >= 0.65) grade = "B+";
  else if (a >= 0.55) grade = "B";
  else if (a >= 0.4) grade = "C+";
  else if (a >= 0.25) grade = "C";
  else if (a >= 0.1) grade = "D";
  else grade = "E";

  // 上限 B：有权威反证时不许 A 档，但不影响上面的 F 下限。
  if (input.highAuthorityConflict && GRADE_ORDER.indexOf(grade) < GRADE_ORDER.indexOf("B")) {
    return { grade: "B", reason: "capped:high_authority_conflict", capped: true };
  }

  return { grade, reason: "graded:" + grade, capped: false };
}

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return Math.max(0, Math.min(1, x));
}
