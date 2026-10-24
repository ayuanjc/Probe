import { buildDossierView, effectiveSampleSize, type DossierView } from "./agreement";
import { UNVERIFIABLE_REASON, claimWeight, isVerifiableKind } from "./claim-kind";
import type { Claim, ClaimVerdict } from "./schemas";

/**
 * 文档级组装：把「断言 + 判定 + 留出集证据」压成一张卡片要用的东西。
 *
 * 分界线很清楚：
 *   - agreement.ts 只管数学（权重、n_eff、Wilson、加权吻合度），不知道断言是什么；
 *   - verify.ts 只管一条断言一条断言地去核，不知道文档长什么样；
 *   - 本文件负责「哪条断言算数、哪条证据有资格投票、分母到底是谁」，并把账记成
 *     degraded 列表交给界面。三者任何一方改动都不该让另外两方跟着改。
 *
 * 这里不做任何模型调用，纯函数 —— 所以它可以被单测钉死，而 verify 不行。
 */

/** 四态。第四态（不可核验）由 claim.kind 决定，不由 verdict 决定（schemas.ts 同口径）。 */
export type ClaimStatus = "supported" | "contradicted" | "unverified" | "unverifiable";

/** 界面文案与 status 一一对应，不在这里做判断，只做翻译。 */
export const STATUS_LABEL: Record<ClaimStatus, string> = {
  supported: "已支持",
  contradicted: "存在矛盾",
  unverified: "未找到证据",
  unverifiable: "不可核验",
};

/**
 * 证据的 authority 缺省值。
 *
 * 0.6 不是随便取的：VERIFY-ARCH §1.5 里「≥2 个独立 owner 且 authority ≥ 0.7 同时判 contradict」
 * 才封顶到 B，0.6 明确落在那一档之下 —— 缺省的权威度不足以单枪匹马否定一条断言。
 */
export const DEFAULT_AUTHORITY = 0.6;

/** 一条外部证据的投票资格。owner 用来判独立，authority 是它的分量，两者缺一不可。 */
export type EvidenceAuthority = { id: string; owner: string; authority?: number };

export type DossierRow = {
  claimIndex: number;
  attr: string;
  value: string;
  kind: Claim["kind"];
  quote: string;
  status: ClaimStatus;
  label: string;
  reason: string;
  evidenceIds: string[];
  /** 这条断言在「可核验率」里的分量；不可核为 0，界面据此决定要不要显示它。 */
  weight: number;
};

export type DossierInput = {
  claims: readonly Claim[];
  /** 判定结果，按 claimIndex 回填（与 verify.ts 的输出直接对接）。 */
  verdicts: readonly ClaimVerdict[];
  /** 留出集证据的 owner 与权威度。判定里出现的 evidence id 只能在这里查到才算数。 */
  evidence?: readonly EvidenceAuthority[];
  /** 本文自己引用过的 owner：出现在这里的一律不进分母（自证不算独立）。 */
  citedOwners?: readonly string[];
  /** 已经算好的 n_eff（effectiveOwners().nEff）。不给就按证据 owner 现算。 */
  nEff?: number;
  /** fixture / 演示数据：只用来加角标，不改分数（封顶在 computeConfidence 里做）。 */
  demo?: boolean;
};

export type DossierCounts = {
  supported: number;
  contradicted: number;
  unverified: number;
  unverifiable: number;
  /** 真正进了判定的条数 = supported + contradicted。这是吻合度的分母。 */
  judged: number;
  /** 可核验断言总数 = judged + unverified。这是「可核验率」的分母。 */
  verifiable: number;
};

export type DossierResult = {
  rows: DossierRow[];
  view: DossierView;
  counts: DossierCounts;
  /**
   * 非 null 时 view.agreement 一定是 null：界面显示「本轮无外部核验」，
   * 不回落到 0 或 0.5。all_unverifiable 与 no_evidence 的区别是「都不可核」还是「一条都没核」。
   */
  blocked: "no_evidence" | "all_unverifiable" | null;
  demo: boolean;
  /** 账目：哪些行被降级、哪些证据被剔除。界面上不显示，但出问题时要能对上。 */
  degraded: string[];
};

function normOwner(x: string): string {
  return (x || "").trim().toLowerCase().replace(/^www\./, "");
}

/**
 * 把断言图算成卡片模型。
 *
 * 三条硬规则，写在这里而不是散在调用方：
 *   1. 自证不算票：证据 owner 落在 citedOwners 里就整条剔除（记 degraded，不静默丢）。
 *   2. 没证据的 support 不算支持：判定说 support 但证据 id 在留出集里查不到，按「未找到证据」处理。
 *      这是最常见的脏数据 —— 判定器顺着本文的引文说话，却把引文 id 填成了证据 id。
 *   3. 分母分两个：吻合度只数 judged，可核验率数 verifiable。两者绝不相乘成一个百分比。
 */
export function buildDossier(input: DossierInput): DossierResult {
  const degraded: string[] = [];

  const cited = new Set<string>();
  for (const owner of input.citedOwners ?? []) cited.add(normOwner(owner));

  const authority = new Map<string, number>();
  const ownerBest = new Map<string, number>();
  for (const ev of input.evidence ?? []) {
    const explicit = typeof ev.authority === "number" && Number.isFinite(ev.authority);
    const raw = explicit ? (ev.authority as number) : DEFAULT_AUTHORITY;
    const w = Math.max(0, Math.min(1, raw));
    if (!explicit) degraded.push("dossier:authority_default_" + ev.id);
    const key = normOwner(ev.owner);
    if (cited.has(key)) {
      // 自证：本文引过这家，它就不能再当外部证据投票。
      degraded.push("dossier:self_citation_dropped_" + ev.id);
      continue;
    }
    authority.set(ev.id, w);
    ownerBest.set(key, Math.max(ownerBest.get(key) ?? 0, w));
  }

  const verdictAt = new Map<number, ClaimVerdict>();
  for (const v of input.verdicts) verdictAt.set(v.claimIndex, v);

  const support: number[] = [];
  const contradict: number[] = [];
  const rows: DossierRow[] = [];

  input.claims.forEach((claim, claimIndex) => {
    const verdict = verdictAt.get(claimIndex) ?? null;
    const verifiable = isVerifiableKind(claim.kind);

    let status: ClaimStatus;
    if (!verifiable) status = "unverifiable";
    else if (!verdict || verdict.verdict === "neutral") status = "unverified";
    else status = verdict.verdict === "support" ? "supported" : "contradicted";

    let reason =
      verdict && verdict.reason
        ? verdict.reason
        : verifiable
          ? "未核验：未进入核验批次。"
          : UNVERIFIABLE_REASON;
    let evidenceIds: string[] = [];

    if (status === "supported" || status === "contradicted") {
      const seen = new Set<string>();
      let counted = 0;
      for (const id of verdict ? verdict.evidenceIds : []) {
        if (seen.has(id)) continue;
        seen.add(id);
        const w = authority.get(id);
        if (w === undefined) continue;
        evidenceIds.push(id);
        (status === "supported" ? support : contradict).push(w);
        counted += 1;
      }
      if (counted === 0) {
        // 判定有票但票不合法：降级成未找到证据，并把原因写清楚。
        degraded.push("dossier:verdict_without_evidence_" + claimIndex);
        status = "unverified";
        evidenceIds = [];
        reason =
          "判定给出的证据不在留出集里，按未找到证据处理。" +
          (verdict && verdict.reason ? " " + verdict.reason : "");
      }
    }

    rows.push({
      claimIndex,
      attr: claim.attr,
      value: claim.value,
      kind: claim.kind,
      quote: claim.quote,
      status,
      label: STATUS_LABEL[status],
      reason,
      evidenceIds,
      weight: claimWeight(claim),
    });
  });

  const counts: DossierCounts = {
    supported: 0,
    contradicted: 0,
    unverified: 0,
    unverifiable: 0,
    judged: 0,
    verifiable: 0,
  };
  for (const row of rows) {
    if (row.status === "supported") counts.supported += 1;
    else if (row.status === "contradicted") counts.contradicted += 1;
    else if (row.status === "unverified") counts.unverified += 1;
    else counts.unverifiable += 1;
  }
  counts.judged = counts.supported + counts.contradicted;
  counts.verifiable = counts.judged + counts.unverified;

  // n_eff 按 owner 去重取最强一条：同一家给 5 条证据仍然只值 1 票（Kish 有效样本量）。
  const nEff =
    typeof input.nEff === "number" && Number.isFinite(input.nEff) && input.nEff > 0
      ? input.nEff
      : effectiveSampleSize([...ownerBest.values()]);

  const coverage = counts.verifiable > 0 ? counts.judged / counts.verifiable : null;

  const view = buildDossierView({
    support,
    contradict,
    nEff,
    // 单判定者没有信源间一致性可言：κ / AC1 留 null，界面显示「未计」而不是 0。
    kappa: null,
    kappaExpected: null,
    ac1: null,
    nChecked: counts.judged,
    nSilent: counts.unverified,
    coverage,
  });

  let blocked: DossierResult["blocked"] = null;
  if (rows.length === 0) blocked = "no_evidence";
  else if (counts.judged === 0) blocked = counts.verifiable === 0 ? "all_unverifiable" : "no_evidence";

  return { rows, view, counts, blocked, demo: input.demo === true, degraded };
}

/** 卡片标题用的唯一名字。PRD 边界：不做事实裁决，所以只叫「外部吻合度」。 */
export const DOSSIER_TITLE = "外部吻合度";
