
import { JudgeOutputSchema } from "@/lib/schemas";
import type { Claim, ClaimVerdict, JudgeOutput, Verdict } from "@/lib/schemas";
import { CHECK_WORTHY_THRESHOLD, checkWorthy, selectVerifiable } from "@/lib/check-worthy";
import type { GateResult } from "@/lib/check-worthy";
import { UNVERIFIABLE_REASON, isVerifiableKind } from "@/lib/claim-kind";
import { generateStructured, llmEnabled } from "@/lib/llm";
import type { UsageSink } from "@/lib/metrics";

/** 前置过滤的阈值从这里走，避免两个模块各写一个 0.4。 */
export { CHECK_WORTHY_THRESHOLD, checkWorthy };
export type { GateResult };

/**
 * 核验层：断言 → 留出集检索 → 三态判定。
 *
 * 三个不对称是这一层的全部设计：
 *
 *   1. **留出集**。检索得到的证据必须来自本文没有引用过的 owner。让文章自证是
 *      最容易也最没用的做法 —— 一篇错误文章总能给自己的每一句找到出处，
 *      而一致率会漂亮的接近 1。所以 held-out 是硬约束，宁可返回空集，也不许回退到本文引用。
 *
 *   2. **三态**。没找到证据（neutral）与证据说不是（contradict）必须分开记录。
 *      合并成两值的话，「没人报道过」会被算成「有争议」，冷门但正确的断言因此扣分；
 *      反过来，错误但被大量转载的断言会因为「很多人这么说」显得被支持。
 *      沉默螺旋在数据层的版本，受害者换成了正确但不流行的那句话。
 *
 *   3. **先分流再排队**。因果 / 观点 / 预测三类断言压根进不了判定队列（见 claim-kind.ts）：
 *      它们的最佳结局也就是 neutral，却会实打实占预算、并让「未核验 K 条」这个数虚高。
 *      它们只出现在 verdicts 里（标成不可核验），不参与吻合度的分子分母。
 *
 * 这一层不做裁决，只产出可展开的判定记录；文档级吻合度由 agreement.ts 汇总，
 * 界面上永远只显示「有效吻合度 + Wilson 区间 + 有效独立源数」，不给一个裸分数。
 */

/** 一条留出证据。刻意不带 sourceIds：它不是本文的引用，是外部材料。 */
export type HeldoutEvidence = {
  id: string;
  url: string;
  /** 发布方（域名或署名机构）。判重靠它，不靠 url，因为同一家会有多个栏目。 */
  owner: string;
  title: string;
  /** 与断言最相关的那几句原文，判定器只看这个。 */
  text: string;
};

export type VerifyDeps = {
  /** 留出集检索。空数组是合法结果，含义是「独立来源里确实没有可比对的材料」。 */
  findEvidence: (claim: Claim, claimIndex: number) => Promise<HeldoutEvidence[]>;
  /**
   * 判定器。必须与写作者不是同一个模型（Panickssery 2024：自评会系统性偏好自己的输出）——
   * 这由调用方保证，verify.ts 只负责不把 null 当成 support。
   */
  judge: (claim: Claim, evidence: HeldoutEvidence[]) => Promise<JudgeOutput | null>;
};

export type VerifyBlocked = "no_heldout_retriever" | "budget_exhausted";

export type VerifyResult = {
  verdicts: ClaimVerdict[];
  /** 前置过滤的账：为什么这一轮只核了 6 条，界面上要能对上。下标已映射回原断言数组。 */
  gate: GateResult;
  /** 非 null 时 verdicts 一定为空，界面必须显示「本轮没有做外部核验」而不是 0 分。 */
  blocked: VerifyBlocked | null;
  /** 因果 / 观点 / 预测类断言的条数：不进吻合度分子分母，只进「可核验率」的分母。 */
  unverifiable: number;
  /**
   * 本轮真正喂给判定器的留出证据（按 id 去重）。下游 buildDossier 要靠它的 owner
   * 去算「有效独立源数」—— 只回 verdicts（里面只有 evidenceIds）的话，
   * 每条证据属于谁、有没有重复投票，下游就无从判断了。
   */
  evidence: HeldoutEvidence[];
  degraded: string[];
};

export type VerifyOptions = {
  /** 前置过滤阈值，默认 CHECK_WORTHY_THRESHOLD。 */
  threshold?: number;
  /**
   * 本文自己引用过的 owner 集合。留出集里出现同名 owner 一律剔除 ——
   * 防的是「检索把本文引用的那家重新捞回来」这种最常见的假独立。
   */
  citedOwners?: Iterable<string>;
  /** 单轮核验上限。超出的断言记 degraded，不偷偷丢掉。 */
  maxClaims?: number;
  /** 每条断言最多回填几条证据 id，只影响展开区长度。 */
  maxEvidenceIds?: number;
};

const DEFAULT_MAX_CLAIMS = 12;
const DEFAULT_MAX_EVIDENCE = 3;

/** 不可核断言的统一理由：界面上要能一眼看出「这条从来没打算核」，而不是「核了没结果」。 */
// 文案定义在 claim-kind.ts —— dossier.ts 也要用，不能有第二份。

function normOwner(x: string): string {
  return (x || "").trim().toLowerCase().replace(/^www\./, "");
}

/** 只筛不核：给调用方一个「如果核，会核哪几条」的预览，成本为零。 */
export function gateClaims(claims: Claim[], threshold = CHECK_WORTHY_THRESHOLD): GateResult {
  return selectVerifiable(claims, threshold);
}

function neutral(claimIndex: number, reason: string): ClaimVerdict {
  return { claimIndex, verdict: "neutral", reason, evidenceIds: [] };
}

function asVerdict(v: string): Verdict | null {
  return v === "support" || v === "contradict" || v === "neutral" ? v : null;
}

export type VerifyOneResult = {
  verdict: ClaimVerdict;
  /** 真正喂给判定器的留出证据（已剔自证）。没走到判定那一步时为空数组。 */
  evidence: HeldoutEvidence[];
  degraded: string[];
};

/**
 * 核一条断言。从 verifyClaims 里抽出来，是因为文档核验那条链要在每一条之后
 * 立刻把 evidence.retrieved / nli.verdict 推给前端（一篇文章 12 条断言串行跑一分多钟，
 * 攒到最后一次性发等于让用户盯着一个空屏幕）。两处共用同一份判定逻辑，
 * 才不会出现「接口核出来的结果」和「流水线核出来的结果」两套口径。
 */
export async function verifyOne(
  claim: Claim,
  claimIndex: number,
  deps: VerifyDeps,
  opts: { citedOwners?: Iterable<string>; maxEvidenceIds?: number } = {},
): Promise<VerifyOneResult> {
  const maxEvidence = Math.max(1, opts.maxEvidenceIds ?? DEFAULT_MAX_EVIDENCE);
  const cited = new Set<string>();
  for (const o of opts.citedOwners ?? []) cited.add(normOwner(o));

  const degraded: string[] = [];

  let fetched: HeldoutEvidence[] = [];
  try {
    fetched = (await deps.findEvidence(claim, claimIndex)) ?? [];
  } catch {
    degraded.push("verify:find_failed_" + claimIndex);
    return {
      verdict: neutral(claimIndex, "留出集检索失败，这条断言没有做外部比对。"),
      evidence: [],
      degraded,
    };
  }

  // 自己不能给自己作证：owner 与本文引用重合的一律剔除。
  const held = fetched.filter((e) => e && e.id && !cited.has(normOwner(e.owner)));
  if (held.length === 0) {
    return {
      verdict: neutral(
        claimIndex,
        "留出集为空：本文引用之外的独立来源里没有可比对的材料。没有反证不等于没有反证 —— 这条不计入吻合度分母。",
      ),
      evidence: [],
      degraded,
    };
  }

  let out: JudgeOutput | null = null;
  try {
    out = await deps.judge(claim, held);
  } catch {
    out = null;
  }
  if (!out) {
    degraded.push("verify:judge_failed_" + claimIndex);
    // 证据还是要交出去：判定器挂了不等于检索没结果，前端照样该能展开看证据。
    return { verdict: neutral(claimIndex, "判定器没有给出结论，这条按未核验计。"), evidence: held, degraded };
  }

  const v = asVerdict(out.verdict);
  if (!v) {
    degraded.push("verify:bad_verdict_" + claimIndex);
    return {
      verdict: neutral(claimIndex, "判定器返回了无法识别的结论，按未核验计。"),
      evidence: held,
      degraded,
    };
  }

  return {
    verdict: {
      claimIndex,
      verdict: v,
      reason: (out.reason || "").trim().slice(0, 240),
      evidenceIds: v === "neutral" ? [] : held.slice(0, maxEvidence).map((e) => e.id),
    },
    evidence: held,
    degraded,
  };
}

/**
 * 核实一轮断言。
 *
 * deps 为 null 是本函数的默认姿态，不是错误分支：没有留出集检索器时，
 * 唯一诚实的输出就是「本轮没有做外部核验」。这里绝不回退到自证，
 * 也绝不返回一个看起来像 0 分的 verdicts 数组。
 */
export async function verifyClaims(
  claims: Claim[],
  deps: VerifyDeps | null,
  opts: VerifyOptions = {},
): Promise<VerifyResult> {
  const threshold = opts.threshold ?? CHECK_WORTHY_THRESHOLD;
  const degraded: string[] = [];

  // 先按 kind 分流。不可核的三类不进队列：抢预算的是它们，永远拿 neutral 的也是它们。
  const verifiable: { claim: Claim; index: number }[] = [];
  const unverifiable: { claim: Claim; index: number }[] = [];
  claims.forEach((claim, index) => {
    (isVerifiableKind(claim.kind) ? verifiable : unverifiable).push({ claim, index });
  });

  const scoped = selectVerifiable(
    verifiable.map((x) => x.claim),
    threshold,
  );
  // selectVerifiable 的下标是「可核子集」里的位置，必须映射回原数组 ——
  // 否则 claimIndex 指到的是别的断言，而这类错位在下游看起来完全正常。
  const toOriginal = (i: number): number => verifiable[i]?.index ?? i;
  const gate: GateResult = {
    ...scoped,
    kept: scoped.kept.map((it) => ({ ...it, index: toOriginal(it.index) })),
  };

  // blocked 时 verdicts 必须为空（界面据此显示「本轮没有做外部核验」），
  // 所以不可核标注只在真正跑了核验的路径里落。
  if (!deps) {
    return {
      verdicts: [],
      gate,
      blocked: "no_heldout_retriever",
      unverifiable: unverifiable.length,
      evidence: [],
      degraded,
    };
  }

  const verdicts: ClaimVerdict[] = unverifiable.map((x) => neutral(x.index, UNVERIFIABLE_REASON));

  const maxClaims = Math.max(0, opts.maxClaims ?? DEFAULT_MAX_CLAIMS);
  const maxEvidence = Math.max(1, opts.maxEvidenceIds ?? DEFAULT_MAX_EVIDENCE);

  const batch = gate.kept.slice(0, maxClaims);
  if (gate.kept.length > batch.length) {
    // 超出预算不是「没问题」，是这一轮少核了东西 —— 必须记下来。
    degraded.push("verify:capped_" + (gate.kept.length - batch.length));
  }
  if (batch.length === 0) {
    return {
      verdicts,
      gate,
      blocked: "budget_exhausted",
      unverifiable: unverifiable.length,
      evidence: [],
      degraded,
    };
  }

  // 同一个 url 可能被多条断言各自检索到：只留一份，否则它会以「多条证据」的身份
  // 重复投票，而它们其实只代表一家媒体的一个说法。
  const seenEvidence = new Map<string, HeldoutEvidence>();

  for (const item of batch) {
    const one = await verifyOne(item.claim, item.index, deps, {
      citedOwners: opts.citedOwners,
      maxEvidenceIds: maxEvidence,
    });
    verdicts.push(one.verdict);
    degraded.push(...one.degraded);
    for (const e of one.evidence) if (!seenEvidence.has(e.id)) seenEvidence.set(e.id, e);
  }

  return {
    verdicts,
    gate,
    blocked: null,
    unverifiable: unverifiable.length,
    evidence: [...seenEvidence.values()],
    degraded,
  };
}

/**
 * 把 verdicts 摊回「每条断言一个」的形状：没核的按 kind 补理由，方便直接落库。
 * 不可核的断言补「不可核验」，可核但没轮到的补「未进入核验批次」——
 * 两种 missing 在界面上是两种颜色，混成一句会让用户以为我们漏核了。
 */
export function alignVerdicts(claims: Claim[], verdicts: ClaimVerdict[]): ClaimVerdict[] {
  const byIndex = new Map<number, ClaimVerdict>();
  for (const v of verdicts) byIndex.set(v.claimIndex, v);
  return claims.map(
    (c, i) =>
      byIndex.get(i) ??
      neutral(
        i,
        isVerifiableKind(c.kind)
          ? "未进入核验批次（前置过滤或预算上限）。"
          : UNVERIFIABLE_REASON,
      ),
  );
}

/**
 * 默认判定器：把断言与留出证据一起交给模型，要求三态之一 + 一句理由。
 * 无 key 时返回 null（调用方按未核验计），绝不返回一个「大概是 support」的猜测。
 */
export function llmJudge(sink?: UsageSink): VerifyDeps["judge"] {
  return async (claim, evidence) => {
    if (!llmEnabled()) return null;
    const bundle = evidence.slice(0, 6).map((e) => ({
      id: e.id,
      owner: e.owner,
      title: e.title,
      text: e.text.slice(0, 600),
    }));
    return generateStructured<JudgeOutput>(
      {
        schema: JudgeOutputSchema,
        system:
          "你在核对一条被抽取出来的断言。只依据给定证据判断，不要引入外部知识。" +
          "support = 证据明确支持该断言；contradict = 证据明确与之冲突（数字、日期、人物、方向相反）；" +
          "neutral = 证据没有涉及该断言的关键点（不要因为「没提到」就判 contradict）。" +
          "quote 必须是证据里的原句，neutral 时留空；reason 一句话，说清依据哪条证据。",
        prompt:
          "断言：" +
          claim.attr +
          " = " +
          claim.value +
          (claim.unit ? " " + claim.unit : "") +
          "\n原文：" +
          claim.quote +
          "\n证据：" +
          JSON.stringify(bundle, null, 1),
      },
      sink,
    );
  };
}
