
"use client";

import type { Confidence } from "@/lib/schemas";

const BAND_TEXT: Record<Confidence["band"], string> = {
  high: "高置信",
  medium: "中等置信",
  low: "低置信",
};

const BAND_STYLE: Record<Confidence["band"], string> = {
  high: "text-[#5eead4] border-[#5eead4]/35 bg-[#5eead4]/8",
  medium: "text-[#fbbf24] border-[#fbbf24]/35 bg-[#fbbf24]/8",
  low: "text-[#7b8798] border-white/15 bg-white/4",
};

export default function ConfidenceBadge({ confidence }: { confidence: Confidence }) {
  return (
    <details className="group inline-block">
      <summary
        className={
          "cursor-pointer select-none list-none rounded border px-2 py-1 text-[11px] tracking-wide " +
          BAND_STYLE[confidence.band]
        }
      >
        {BAND_TEXT[confidence.band]} · {(confidence.score * 100).toFixed(0)}%
        <span className="ml-1 text-current/60 group-open:hidden">▾</span>
        <span className="ml-1 hidden text-current/60 group-open:inline">▴</span>
      </summary>
      <div className="mt-2 w-72 rounded border border-white/10 bg-[#0b0d11] p-3 text-[11px] leading-relaxed text-[#94a3b8]">
        <div className="mb-2 text-[#e2e8f0]">置信度由三个分量加权，可展开核对：</div>
        <Row label="一手性 P（权重 40%）" value={confidence.firstHand} hint="非转载条目占比" />
        <Row label="独立性 I（权重 35%）" value={confidence.independence} hint={confidence.nOwners + " 个独立稿源"} />
        <Row
          label="一致性 C（权重 25%）"
          value={confidence.consistency}
          hint={confidence.nChecked > 0 ? "核对 " + confidence.nChecked + " 条，冲突 " + confidence.nConflicts + " 条" : "无可交叉核对的断言"}
        />
        <div className="mt-2 border-t border-white/10 pt-2 text-[11px] text-[#7b8798]">
          疑似转载 {confidence.nSyndicated} 条
        </div>
      </div>
    </details>
  );
}

function Row({ label, value, hint }: { label: string; value: number; hint: string }) {
  return (
    <div className="mb-2 last:mb-0">
      <div className="flex items-baseline justify-between">
        <span>{label}</span>
        <span className="text-[#e2e8f0]">{(value * 100).toFixed(0)}</span>
      </div>
      <div className="mt-1 h-1 w-full overflow-hidden rounded bg-white/8">
        <div
          className="h-full rounded bg-[#5eead4]/70"
          style={{ width: Math.round(Math.max(0, Math.min(1, value)) * 100) + "%" }}
        />
      </div>
      <div className="mt-1 text-[10px] text-[#5c6675]">{hint}</div>
    </div>
  );
}
