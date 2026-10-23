"use client";

import type { ReactNode } from "react";
import type { Confidence } from "@/lib/schemas";
import Term from "./Glossary";

const BAND_TEXT: Record<Confidence["band"], string> = {
  high: "高置信",
  medium: "中等置信",
  low: "低置信",
};

const BAND_STYLE: Record<Confidence["band"], string> = {
  high: "text-cyan-400 border-cyan-500/30 bg-cyan-500/10",
  medium: "text-amber-400 border-amber-400/30 bg-amber-400/10",
  low: "text-neutral-300 border-white/10 bg-white/[0.06]",
};

export default function ConfidenceBadge({ confidence }: { confidence: Confidence }) {
  return (
    <details className="group inline-block">
      <summary
        className={
          "cursor-pointer select-none list-none rounded border px-3 py-1 font-mono text-[11px] tracking-wide backdrop-blur-xl " +
          BAND_STYLE[confidence.band]
        }
        title="展开看三个分量与封顶规则"
      >
        {BAND_TEXT[confidence.band]} · {(confidence.score * 100).toFixed(0)}%
        <span className="ml-1 text-current/60 group-open:hidden">▾</span>
        <span className="ml-1 hidden text-current/60 group-open:inline">▴</span>
      </summary>
      <div className="mt-2 w-80 rounded-lg border border-white/10 bg-[#0a0a0c]/95 p-4 text-[11px] leading-relaxed text-neutral-400 shadow-[0_30px_80px_-30px_rgba(0,0,0,0.95)] backdrop-blur-xl">
        <div className="mb-2.5 text-white">
          <Term k="confidence" align="left">
            置信度
          </Term>{" "}
          由三个分量加权，可展开核对：
        </div>
        <Row
          label={
            <>
              <Term k="firstHand" align="left">
                一手性 P
              </Term>
              （权重 40%）
            </>
          }
          value={confidence.firstHand}
          hint="非转载条目占比"
        />
        <Row
          label={
            <>
              <Term k="independence" align="left">
                独立性 I
              </Term>
              （权重 35%）
            </>
          }
          value={confidence.independence}
          hint={confidence.nOwners + " 个独立稿源 · 1 − e^(−n/3)"}
        />
        <Row
          label={
            <>
              <Term k="consistency" align="left">
                一致性 C
              </Term>
              （权重 25%）
            </>
          }
          value={confidence.consistency}
          hint={
            confidence.nChecked > 0 ? (
              "核对 " + confidence.nChecked + " 条，冲突 " + confidence.nConflicts + " 条"
            ) : (
              <>
                <Term k="nChecked" align="left">
                  核对条数
                </Term>{" "}
                为 0：按 0.5 记，总分封顶 0.74
              </>
            )
          }
        />
        <div className="mt-2 flex items-center justify-between border-t border-white/10 pt-2 font-mono text-[10px] text-neutral-500">
          <span>
            <Term k="nSyndicated" align="left">
              疑似转载
            </Term>
          </span>
          <span className="tabular-nums">{confidence.nSyndicated} 条</span>
        </div>
      </div>
    </details>
  );
}

function Row({ label, value, hint }: { label: ReactNode; value: number; hint: ReactNode }) {
  return (
    <div className="mb-2 last:mb-0">
      <div className="flex items-baseline justify-between gap-3">
        <span>{label}</span>
        <span className="font-mono tabular-nums text-cyan-400">{(value * 100).toFixed(0)}</span>
      </div>
      <div className="mt-1 h-1 w-full overflow-hidden rounded bg-white/10">
        <div
          className="h-full rounded bg-cyan-400/80 shadow-[0_0_8px_rgba(34,211,238,0.7)]"
          style={{ width: Math.round(Math.max(0, Math.min(1, value)) * 100) + "%" }}
        />
      </div>
      <div className="mt-1 font-mono text-[10px] text-neutral-500">{hint}</div>
    </div>
  );
}
