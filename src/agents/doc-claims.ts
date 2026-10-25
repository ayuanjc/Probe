/**
 * 文档断言抽取：把一段正文变成「可核验的断言 + 原文坐标」。
 *
 * 两条硬约束（都在服务端执行，不信模型自述）：
 *
 *   1. **quote 必须在原文里定位得到**。模型编造 quote 是最常见的失败模式，而且编得像：
 *      语气对、术语对、量级对，只有一个数字或一个百分号不同。定位不到就整条丢，
 *      并记下 quote_miss 让用户看得见「我们丢了几条」。
 *   2. **坐标由服务端算**，不由模型给。模型给的 charStart 会漂，而功能「点击回到原文」
 *      完全依赖这个偏移 —— 偏一个字符，高亮就落到前一句的句号上。
 *
 * 抽取是唯一花模型额度的环节，所以每段有硬上限（MAX_CLAIMS_PER_SEGMENT）：
 * 一段 3000 字里塞 20 条断言，核验成本会按条数线性爆炸，而多出来的那 14 条
 * 通常是同一句话的重复切分。
 */
import { z } from "zod";
import { ClaimKindSchema, type Claim } from "@/lib/schemas";
import { generateStructured, llmEnabled } from "@/lib/llm";
import type { UsageSink } from "@/lib/metrics";
import { verifyExtractedClaim, type QuoteRejectCode } from "@/lib/claim-extract";
import type { DocSegment } from "@/lib/verify-doc";

export const MAX_CLAIMS_PER_SEGMENT = 6;

const RawClaimSchema = z.object({
  quote: z.string().max(400),
  attr: z.string().max(60),
  value: z.string().max(120),
  unit: z.string().max(24).optional(),
  kind: ClaimKindSchema,
});

export const ExtractedClaimsSchema = z.object({
  claims: z.array(RawClaimSchema).max(MAX_CLAIMS_PER_SEGMENT * 2),
});

export type ExtractedClaims = z.infer<typeof ExtractedClaimsSchema>;

/** 带坐标的断言。Claim 本身是给下游用的，坐标只给前端高亮与「回到原文」。 */
export type DocClaim = Claim & { charStart: number; charEnd: number };

export type SegmentClaimResult = {
  segmentIdx: number;
  claims: DocClaim[];
  /** 被服务端复核丢掉的条数与原因码。用户要能看见「模型抽了 8 条，我们只认 5 条」。 */
  dropped: { count: number; codes: QuoteRejectCode[] };
  degraded: string[];
};

const SYSTEM = [
  "你是事实核查助手。从给定段落里抽出「具体的、可以被外部材料证实或反驳的断言」。",
  "每条断言给 quote（必须逐字摘自段落）、attr（属性名，2-10 字）、value（值）、unit（单位，可选）、kind。",
  "kind 取值：quantitative（数字/金额/份额/排名）、temporal（日期/时点/期限）、",
  "attribution（谁说了、谁做的、谁拥有）、existence（存在/上线/具备某功能）、",
  "causal（导致/使得/带动）、opinion（显著/看好/值得）、prediction（将/预计/有望/计划）。",
  "优先序：prediction > causal > opinion > quantitative > temporal > attribution > existence。",
  "硬约束：quote 必须是段落里的原话，一个字都不要改；找不到原话就不要输出这条；",
  "不要解释、不要总结、不要输出段落里没有的数字。",
  "最多 6 条，按「最值得核」排序（具体的数字与日期排前面，泛泛的评价排后面）。",
].join("\n");

/**
 * 抽一段。模型没 key 时返回空结果（不是错误）—— 调用方据此写 claims:unavailable，
 * 而不是把「没接模型」说成「这篇文章没有可核的断言」。
 */
export async function extractSegmentClaims(
  seg: DocSegment,
  sink?: UsageSink,
  signal?: AbortSignal,
): Promise<SegmentClaimResult> {
  const base: SegmentClaimResult = {
    segmentIdx: seg.idx,
    claims: [],
    dropped: { count: 0, codes: [] },
    degraded: [],
  };
  if (!llmEnabled()) return base;

  const text = seg.text.slice(0, 6_000);
  let out: ExtractedClaims | null = null;
  try {
    out = await generateStructured<ExtractedClaims>(
      {
        schema: ExtractedClaimsSchema,
        system: SYSTEM,
        prompt: "段落：\n" + text,
      },
      sink,
      signal,
    );
  } catch {
    return { ...base, degraded: ["claims:extract_failed_" + seg.idx] };
  }
  if (!out || !Array.isArray(out.claims)) {
    return { ...base, degraded: ["claims:extract_failed_" + seg.idx] };
  }

  const claims: DocClaim[] = [];
  const codes: QuoteRejectCode[] = [];
  let rejected = 0;
  for (const raw of out.claims) {
    if (claims.length >= MAX_CLAIMS_PER_SEGMENT) {
      rejected += 1;
      codes.push("over_cap");
      break;
    }
    // offset 用段的起点：坐标要落在全文坐标系里，前端才能滚到正确位置。
    const check = verifyExtractedClaim(seg.text, raw, seg.charStart);
    if (!check.ok) {
      rejected += 1;
      codes.push(check.code);
      continue;
    }
    claims.push({
      attr: check.claim.attr,
      value: check.claim.value,
      quote: check.claim.quote,
      // sourceIds 是「这条断言出自哪份材料」：文档核验里只有一个来源，就是本文。
      sourceIds: ["doc"],
      unit: check.claim.unit,
      kind: check.claim.kind,
      charStart: check.claim.charStart,
      charEnd: check.claim.charEnd,
    });
  }

  return {
    segmentIdx: seg.idx,
    claims,
    dropped: { count: rejected, codes },
    degraded: [],
  };
}