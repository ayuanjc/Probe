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
  /** 本轮没跑完（中断 / 预算顶到）。与 N/A 是两件事，界面别混。 */
  partial: boolean;
  /** 非 null 时 agreement 一定为 null：本轮没有做外部核验。 */
  blocked: "no_evidence" | "all_unverifiable" | "no_claims" | null;
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
