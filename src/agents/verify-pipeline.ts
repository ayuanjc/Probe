import { llmEnabled } from "@/lib/llm";
import { coverageOf, gradeOf } from "@/lib/grade";
import { loadDoc } from "@/lib/verify-doc";
import { authorityOf, HIGH_AUTHORITY } from "@/lib/authority";
import { buildDossier, type DossierResult, type EvidenceAuthority } from "@/lib/dossier";
import { selectVerifiable } from "@/lib/check-worthy";
import { hostOf } from "@/lib/text";
import type { Claim, ClaimVerdict } from "@/lib/schemas";
import type { VerifyEvent, VerifyScoresEvent } from "@/lib/verify-events";
import { ownerOfDomain } from "./retrieve";
import { extractSegmentClaims, type DocClaim } from "./doc-claims";
import { makeHeldoutDeps, tavilyHeldoutSearch } from "./heldout";
import { llmJudge, verifyOne } from "./verify";

/**
 * 文档核验流水线：取文 → 切段 → 抽断言 → 前置过滤 → 逐条检索+判定 → 汇总 → 评级。
 *
 * Phase 1 只跑「证据链的下半截」并把分数钉死为空；Phase 2（本文件的现状）把中间那段
 * 模型环节接上了。改动前要守住四条，每一条都是踩过的坑：
 *
 *   1. **没有断言就不发字母档**，也不发 0/0.5 这种「看起来像分数」的东西。评级 N/A 时
 *      agreement 必须是 null；回落到 0.5 会让「没核」和「核出来持平」看起来一样。
 *   2. **留出集为空就是为空**。检索器没配（缺 key）时走 makeHeldoutDeps 的 null 分支，
 *      记 claims:no_retriever，绝不用本文自己的段落给本文作证。
 *   3. **只核「值得核」的那批**。抽出来 40 条断言全送检索，token 会随条数线性爆炸，
 *      而后 30 条通常是同一句话的重复切分。跳过的条数记在 degraded 里，不静默。
 *   4. **分母分两个**。吻合度只除以 judged（支持+矛盾），可核验率除以 verifiable
 *      （judged+未找到证据）。两者绝不相乘 —— 相乘会把「核得少」伪装成「吻合度低」。
 */

export type VerifyInput = { text?: string; url?: string };

/** 抽断言的段数上限。每段一次模型调用，24 段全抽等于一篇四万字文章烧 24 次。 */
const MAX_SEGMENTS_EXTRACT = 12;
/** 逐条核验的上限。超出的记 degraded，不偷偷丢。 */
const MAX_CLAIMS_VERIFIED = 12;

const CODE_TEXT: Record<string, string> = {
  "verify:empty": "没有正文：粘贴文字，或给一个文章链接。",
  "verify:too_short": "正文不足 120 字，核验出来的东西没有意义。",
  "verify:not_html": "那个链接返回的不是网页正文（多半是 PDF 或一段 JSON）。",
  "verify:url_blocked": "那个地址解析到内网，不抓。",
  "verify:fetch_failed": "抓不到那篇文章的正文。",
};

export function verifyErrorMessage(code: string, detail?: string): string {
  const base = CODE_TEXT[code] ?? "取文失败。";
  return detail ? base + "（" + code + " " + detail + "）" : base + "（" + code + "）";
}

function emptyCounts(): VerifyScoresEvent["counts"] {
  return { supported: 0, contradicted: 0, unverified: 0, unverifiable: 0, judged: 0, verifiable: 0 };
}

/** scoresFrom / emptyScores 的可选口径。拆成对象是因为「为什么没看全」本身就是复数个理由。 */
type ScoresOpts = {
  /** 覆盖不全的理由，机器码；空数组 = 全文全断言都过了。 */
  gaps?: string[];
  /** 请求中途被取消（不是系统截的）。 */
  aborted?: boolean;
  /** ≥2 家权威来源顶了同一条结论，评级压到 B。 */
  highAuthorityConflict?: boolean;
};

/**
 * 把「本轮没看全」的理由列出来 —— 空数组就是全文全断言都过了。
 *
 * 为什么不是布尔：原来 partial 把四种情况混成一句「正文被截断、断言超出预算，或中途中断」，
 * 界面上一半文章都顶着这条黄条，而其中大多数只是「闸门跳过了几条观点句」或「某条断言的检索
 * 失败了」—— 那两种情况下字母档代表的仍然是整篇文章，黄条等于给一个不存在的问题道歉。
 * 现在只有三件「系统真的少看了东西」的事算 partial：正文被截、段落超上限、断言超预算。
 */
export function coverageGaps(input: {
  truncated: boolean;
  segmentsTotal: number;
  segmentsExtracted: number;
  claimsGated: number;
  claimsPicked: number;
}): string[] {
  const gaps: string[] = [];
  if (input.truncated) gaps.push("doc:truncated");
  if (input.segmentsTotal > input.segmentsExtracted) {
    gaps.push("segments:extracted_" + input.segmentsExtracted + "_of_" + input.segmentsTotal);
  }
  if (input.claimsGated > input.claimsPicked) {
    gaps.push("claims:capped_" + input.claimsPicked + "_of_" + input.claimsGated);
  }
  return gaps;
}

/** 零断言时的稳定输出：评级 N/A，理由码交给界面翻译（见 grade.ts 的 N_A_LABEL）。 */
function emptyScores(blocked: VerifyScoresEvent["blocked"], opts: ScoresOpts = {}): VerifyScoresEvent {
  const gaps = opts.gaps ?? [];
  const counts = emptyCounts();
  const g = gradeOf({
    agreement: null,
    judged: 0,
    contradicted: 0,
    verifiable: 0,
    unverifiable: 0,
    highAuthorityConflict: false,
  });
  return {
    grade: g.grade,
    gradeReason: g.reason,
    capped: g.capped,
    agreement: null,
    nEff: 0,
    counts,
    coverage: coverageOf(counts.verifiable, counts.unverifiable),
    partial: gaps.length > 0,
    partialReasons: gaps,
    aborted: opts.aborted === true,
    blocked,
    rows: [],
  };
}

/**
 * 是否存在「≥2 个独立 owner 且 authority ≥ 0.7」的矛盾。
 *
 * 按 claim 逐条判，不是全篇合计：两条不同 claim 各被一家权威来源顶回来，
 * 不等于同一条结论被两家顶回来。后者才是 VERIFY-ARCH §1.5 里降档的理由。
 */
/** 导出只为单测：这条判宽了，任何一篇有争议的文章都会被压到 B。 */
export function hasHighAuthorityConflict(
  verdicts: readonly ClaimVerdict[],
  auth: ReadonlyMap<string, EvidenceAuthority>,
): boolean {
  const ownersByClaim = new Map<number, Set<string>>();
  for (const v of verdicts) {
    if (v.verdict !== "contradict") continue;
    for (const id of v.evidenceIds) {
      const ev = auth.get(id);
      if (!ev) continue;
      const level = typeof ev.authority === "number" ? ev.authority : 0;
      if (level < HIGH_AUTHORITY) continue;
      let bucket = ownersByClaim.get(v.claimIndex);
      if (!bucket) {
        bucket = new Set<string>();
        ownersByClaim.set(v.claimIndex, bucket);
      }
      bucket.add(ev.owner.toLowerCase());
    }
  }
  for (const owners of ownersByClaim.values()) if (owners.size >= 2) return true;
  return false;
}

/** 把 dossier 的组装结果翻成 SSE 的 scores 事件。唯一一处「数字变事件」的地方。 */
/** 导出只为单测：这是「数字 → 事件」的唯一一处翻译，写错了整页都跟着错。 */
export function scoresFrom(dossier: DossierResult, opts: ScoresOpts = {}): VerifyScoresEvent {
  const gaps = opts.gaps ?? [];
  const c = dossier.counts;
  const view = dossier.view;
  const g = gradeOf({
    agreement: view.agreement ? view.agreement.value : null,
    judged: c.judged,
    contradicted: c.contradicted,
    verifiable: c.verifiable,
    unverifiable: c.unverifiable,
    highAuthorityConflict: opts.highAuthorityConflict === true,
  });
  return {
    grade: g.grade,
    gradeReason: g.reason,
    capped: g.capped,
    // 契约：agreement 为 null 时界面显示「未核验」，不能回落到 0.5 或 0。
    agreement: view.agreement,
    nEff: view.nEff,
    counts: {
      supported: c.supported,
      contradicted: c.contradicted,
      unverified: c.unverified,
      unverifiable: c.unverifiable,
      judged: c.judged,
      verifiable: c.verifiable,
    },
    coverage: view.tooltip.coverage,
    partial: gaps.length > 0,
    partialReasons: gaps,
    aborted: opts.aborted === true,
    blocked: dossier.blocked,
    rows: dossier.rows.map((row) => ({
      claimIndex: row.claimIndex,
      quote: row.quote,
      status: row.status,
      label: row.label,
      reason: row.reason,
      weight: row.weight,
    })),
  };
}

/** 本文自己引用过的 owner。防的是「检索把本文引用的那家重新捞回来」这种最常见的假独立。 */
/** 导出只为单测：这条判反了，检索就会把本文引用的那家当成独立来源。 */
export function citedOwnersOf(sourceUrl: string | null): string[] {
  if (!sourceUrl) return [];
  try {
    return [ownerOfDomain(hostOf(sourceUrl))];
  } catch {
    return [];
  }
}

export async function* runVerify(input: VerifyInput, signal?: AbortSignal): AsyncGenerator<VerifyEvent> {
  const started = Date.now();
  const degraded: string[] = [];
  const notes: string[] = [];

  const loaded = await loadDoc(input);
  if (!loaded.ok) {
    yield { event: "error", data: { message: verifyErrorMessage(loaded.code, loaded.detail) } };
    return;
  }

  const { doc, segments } = loaded;
  degraded.push(...loaded.degraded);

  yield {
    event: "doc.parsed",
    data: {
      docId: doc.docId,
      title: doc.title,
      chars: doc.chars,
      truncated: doc.truncated,
      segmentCount: segments.length,
      segments,
    },
  };

  if (signal?.aborted) return;

  // 模型不在线时，连「没抽出断言」和「没接模型」都要分开说：前者是文章的问题，
  // 后者是我们的问题，混成一句会让用户以为自己的文章没救。
  if (!llmEnabled()) {
    notes.push("claims:unavailable");
    const scores = emptyScores("no_claims", {
      gaps: coverageGaps({
        truncated: doc.truncated,
        segmentsTotal: segments.length,
        segmentsExtracted: segments.length,
        claimsGated: 0,
        claimsPicked: 0,
      }),
    });
    yield { event: "doc.scored", data: scores };
    if (signal?.aborted) return;
    yield {
      event: "done",
      data: { scores, notes, degraded, elapsedMs: Date.now() - started, stats: { segments: segments.length, chars: doc.chars, claims: 0 } },
    };
    return;
  }

  // ── 1. 抽断言（逐段，边抽边推事件，用户不必等全文抽完） ──
  const extractFrom = segments.slice(0, MAX_SEGMENTS_EXTRACT);
  if (segments.length > extractFrom.length) {
    degraded.push("verify:segments_capped_" + (segments.length - extractFrom.length));
  }

  const claims: DocClaim[] = [];
  for (const seg of extractFrom) {
    if (signal?.aborted) break;
    const got = await extractSegmentClaims(seg);
    degraded.push(...got.degraded);
    if (got.claims.length === 0 && got.dropped.count === 0) continue;

    // claimIndex 是全文坐标系里的下标（= claims 数组位置），前端展开区靠它对上原文区间。
    const start = claims.length;
    claims.push(...got.claims);
    yield {
      event: "claim.extracted",
      data: {
        segmentIdx: seg.idx,
        claims: got.claims.map((c, i) => ({
          claimIndex: start + i,
          quote: c.quote,
          charStart: c.charStart,
          charEnd: c.charEnd,
          kind: c.kind,
          attr: c.attr,
          value: c.value,
          unit: c.unit,
        })),
        dropped: got.dropped,
      },
    };
  }

  if (claims.length === 0) {
    notes.push("claims:none");
    const scores = emptyScores("no_claims", { aborted: signal?.aborted === true });
    yield { event: "doc.scored", data: scores };
    if (signal?.aborted) return;
    yield {
      event: "done",
      data: {
        scores,
        notes,
        degraded,
        elapsedMs: Date.now() - started,
        stats: { segments: segments.length, chars: doc.chars, claims: 0 },
      },
    };
    return;
  }

  // ── 2. 前置过滤：只核值得核的，跳过条数记账 ──
  const gate = selectVerifiable(claims);
  // skipped 是数组（不是条数）：报告里要能回答「为什么这条没核」，所以要原样带回。
  if (gate.skipped.length > 0) degraded.push("verify:gate_skipped_" + gate.skipped.length);
  const picked = gate.kept.slice(0, MAX_CLAIMS_VERIFIED);
  if (gate.kept.length > picked.length) {
    degraded.push("verify:claims_capped_" + (gate.kept.length - picked.length));
  }

  const citedOwners = citedOwnersOf(doc.sourceUrl);
  // 缺 key 时 tavilyHeldoutSearch 返回 null，于是 deps 为 null —— 走「本轮没有做外部核验」
  // 的诚实分支，绝不回退到用本文自己的段落给自己作证。
  const deps = makeHeldoutDeps({ search: tavilyHeldoutSearch(), judge: llmJudge(), citedOwners });
  if (!deps) notes.push("claims:no_retriever");

  // ── 3. 逐条核验。每条都推 evidence.retrieved，再推 nli.verdict（契约第 2 条）。 ──
  const verdicts: ClaimVerdict[] = [];
  const authById = new Map<string, EvidenceAuthority>();
  let aborted = signal?.aborted === true;

  for (const { claim, index } of picked) {
    if (signal?.aborted) {
      aborted = true;
      break;
    }
    if (!deps) break;

    const one = await verifyOne(claim as Claim, index, deps, { citedOwners });
    degraded.push(...one.degraded);
    verdicts.push(one.verdict);

    const rows = one.evidence.map((e) => {
      const level = authorityOf(e.owner);
      authById.set(e.id, { id: e.id, owner: e.owner, authority: level.authority });
      return {
        id: e.id,
        url: e.url,
        owner: e.owner,
        authority: level.authority,
        snippet: e.text.slice(0, 280),
      };
    });
    yield {
      event: "evidence.retrieved",
      data: { claimIndex: index, evidence: rows, degraded: one.degraded },
    };

    const cited = new Set(one.verdict.evidenceIds);
    for (const row of rows) {
      // 判定器没引用的那条证据记 silent：它被检索到了，但没被用来支持或反驳。
      const label =
        one.verdict.verdict === "support" && cited.has(row.id)
          ? "support"
          : one.verdict.verdict === "contradict" && cited.has(row.id)
            ? "contradict"
            : "neutral";
      yield {
        event: "nli.verdict",
        data: {
          claimIndex: index,
          evidenceId: row.id,
          label,
          conflictKind: label === "contradict" ? "unspecified" : "",
          authority: row.authority,
        },
      };
    }
  }

  // ── 4. 汇总。只把「本轮真核过的那批」交给 dossier：没核的断言不是「未找到证据」。 ──
  const judgedClaims = picked.map((p) => p.claim as Claim);
  const dossier = buildDossier({
    claims: judgedClaims,
    verdicts,
    evidence: [...authById.values()],
    citedOwners,
  });
  degraded.push(...dossier.degraded);

  // 只数「系统真的少看了东西」的三件事：正文被截、段落超上限、断言超预算。
  // 闸门跳过（观点/预测/模糊断言）与检索/判定失败都不算 —— 那些都在 degraded 与 rows 的 reason 里，
  // 把它们混进 partial 会让一条本可以完整的字母档顶着「没跑完」的黄条。
  const gaps = coverageGaps({
    truncated: doc.truncated,
    segmentsTotal: segments.length,
    segmentsExtracted: extractFrom.length,
    claimsGated: gate.kept.length,
    claimsPicked: picked.length,
  });
  const scores = scoresFrom(dossier, {
    gaps,
    aborted,
    highAuthorityConflict: hasHighAuthorityConflict(verdicts, authById),
  });

  yield { event: "doc.scored", data: scores };
  if (signal?.aborted) return;

  yield {
    event: "done",
    data: {
      scores,
      notes,
      degraded,
      elapsedMs: Date.now() - started,
      stats: {
        segments: segments.length,
        chars: doc.chars,
        claims: claims.length,
        gated: picked.length,
        judged: dossier.counts.judged,
      },
    },
  };
}
