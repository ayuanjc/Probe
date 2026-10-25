import type { ClaimStatus } from "./dossier";
import type { Grade } from "./grade";

/**
 * POST /api/verify 的 SSE 事件。
 *
 * 与 src/lib/sse.ts 的 ProbeEvent 是两个独立联合类型：编解码复用同一套 SSE 语法
 * （event: 名 + data: JSON），业务不共用 —— 搜索页的事件序和文档核验的事件序没有
 * 共同点，塞进一个联合类型只会让两边的 switch 都要处理对方的成员。
 *
 * 顺序保证（前端可以据此写状态机，不必自己猜）：
 *   1. doc.parsed 一定第一条；done / error 一定最后一条。
 *   2. 某 claim 的 nli.verdict 一律排在该 claim 的 evidence.retrieved 之后。
 *   3. claim.extracted 按 segmentIdx 严格升序，允许整段缺席，不允许乱序。
 *   4. doc.scored 在 done 之前且只发一次；中途断开不发。
 */

export type VerifyDocEvent = {
  docId: string;
  title: string;
  chars: number;
  truncated: boolean;
  segmentCount: number;
  segments: { idx: number; charStart: number; charEnd: number; text: string }[];
};

export type VerifyClaimEvent = {
  segmentIdx: number;
  claims: {
    claimIndex: number;
    quote: string;
    charStart: number;
    charEnd: number;
    kind: string;
    attr: string;
    value: string;
    unit?: string;
  }[];
  /** 服务端复核丢掉的条数与原因码，例如 quote_miss / value_mismatch。 */
  dropped: { count: number; codes: string[] };
};

export type VerifyCounts = {
  supported: number;
  contradicted: number;
  unverified: number;
  unverifiable: number;
  judged: number;
  verifiable: number;
};

export type VerifyScoresEvent = {
  grade: Grade;
  gradeReason: string;
  /** 是否被「上限 B」压过。 */
  capped: boolean;
  agreement: { value: number; low: number; high: number; n: number } | null;
  nEff: number;
  counts: VerifyCounts;
  coverage: number | null;
  /**
   * 本轮只覆盖了文档的一部分（正文被截、段落或断言顶到上限）。由 partialReasons 派生，别手填。
   * 它说的是「系统没看全」，不包含「用户取消」与「闸门跳过了观点类断言」—— 那两种情况下
   * 字母档仍然是完整的。与 N/A 是两件事，界面别混。
   */
  partial: boolean;
  /** 为什么没看全，机器码（doc:truncated / segments:extracted_12_of_24 / claims:capped_12_of_31）。 */
  partialReasons: string[];
  /** 请求中途被取消：覆盖不全但不是系统截的，文案要和 partial 分开写。 */
  aborted: boolean;
  /** 非 null 时 agreement 一定为 null：本轮没有做外部核验。 */
  /**
   * aborted 与 no_claims 必须分开：一个是「你关掉了页面」，一个是「这篇文章没有可核断言」。
   * 中途取消也常常一条断言都还没抽到，混用会让用户以为自己的文章没救。
   */
  blocked: "no_evidence" | "all_unverifiable" | "no_claims" | "aborted" | null;
  rows: { claimIndex: number; quote: string; status: ClaimStatus; label: string; reason: string; weight: number }[];
};

export type VerifyEvent =
  | { event: "doc.parsed"; data: VerifyDocEvent }
  | { event: "claim.extracted"; data: VerifyClaimEvent }
  | {
      event: "evidence.retrieved";
      data: {
        claimIndex: number;
        evidence: { id: string; url: string; owner: string; authority: number; publishedAt?: string; snippet: string }[];
        degraded: string[];
      };
    }
  | { event: "nli.verdict"; data: { claimIndex: number; evidenceId: string; label: string; conflictKind: string; authority: number } }
  | { event: "spread.signal"; data: { heatScore: number | null; status: string | null; highHeatLowEvidence: boolean } }
  | { event: "doc.scored"; data: VerifyScoresEvent }
  | {
      event: "done";
      data: { scores: VerifyScoresEvent; notes: string[]; degraded: string[]; elapsedMs: number; stats: Record<string, number> };
    }
  | { event: "error"; data: { message: string } };

export const VERIFY_EVENT_NAMES = [
  "doc.parsed",
  "claim.extracted",
  "evidence.retrieved",
  "nli.verdict",
  "spread.signal",
  "doc.scored",
  "done",
  "error",
] as const;

/** 与 sse.ts:80 同一套语法，独立实现是为了让两边的联合类型互不牵连。 */
export function encodeVerifyEvent(e: VerifyEvent): string {
  return `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`;
}

/**
 * partial 的机器码翻成人话。放在契约文件里，是因为它是事件字段的一部分：
 * 文案与 reasons 的生成处必须成对（tests/coverage-gaps.test.ts 两边都钉）。
 */
const GAP_TEXT: Record<string, string> = {
  "doc:truncated": "正文超过 4 万字，后半篇没读",
};

export function coverageGapText(code: string): string {
  const fixed = GAP_TEXT[code];
  if (fixed) return fixed;
  const seg = /^segments:extracted_(\d+)_of_(\d+)$/.exec(code);
  if (seg) return "全文 " + seg[2] + " 段里只从 " + seg[1] + " 段抽了断言";
  const cap = /^claims:capped_(\d+)_of_(\d+)$/.exec(code);
  if (cap) return "过闸 " + cap[2] + " 条断言，只核了前 " + cap[1] + " 条";
  return code;
}
