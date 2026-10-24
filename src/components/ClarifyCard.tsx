"use client";

import type { ClarifyPayload } from "@/lib/polysemy";
import Term from "./Glossary";

/**
 * 歧义澄清卡（PRD 2.1）。
 *
 * 刻意不是弹窗：弹窗会拦住下面的面板，而这张卡的价值只是「顺手确认一下」。
 * 所以它排在意图条下面、摘要上面，用户可以直接无视往下读 ——
 * 面板该出照出，因为流水线从来不等它。
 *
 * 语言上守住一条：只报「这个词有哪几种常见读法、各自会检索到什么」，
 * 不报「你大概想问 X」。猜意图是幻觉的高发区，猜错一次后面全错。
 */

function fmtDay(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso.slice(0, 10);
  return new Date(t).toISOString().slice(0, 10);
}

export default function ClarifyCard({
  payload,
  onPick,
  onDismiss,
}: {
  payload: ClarifyPayload;
  onPick: (query: string) => void;
  onDismiss: () => void;
}) {
  return (
    <section role="group" aria-label="歧义澄清" data-clarify className="panel p-5">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-sm bg-yellow-500/10 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.14em] text-yellow-500">
              <Term k="ambiguity">歧义</Term>
            </span>
            <h2 className="text-sm font-medium text-white">先确认这句话说的是哪个意思</h2>
          </div>
          <p className="mt-1.5 text-[13px] leading-relaxed text-neutral-500">{payload.reason}</p>
        </div>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="忽略歧义提示"
          className="shrink-0 rounded-md px-1.5 py-0.5 text-neutral-600 transition-colors hover:text-neutral-300"
        >
          <span aria-hidden className="text-sm leading-none">×</span>
        </button>
      </div>

      {payload.entities.length > 0 && (
        <div className="mt-4 flex flex-col gap-4">
          {payload.entities.map((e) => (
            <div key={e.name}>
              <div className="flex flex-wrap items-baseline gap-2">
                <span className="font-mono text-xs text-neutral-200">{e.term}</span>
                <span className="text-[10px] text-neutral-600">
                  命中「{e.name}」· 选一种读法重跑
                </span>
              </div>
              <div className="mt-2 grid gap-2 sm:grid-cols-2">
                {e.senses.map((s) => (
                  <button
                    key={s.label}
                    type="button"
                    onClick={() => onPick(s.query)}
                    className="group rounded-md border border-neutral-800 bg-[#0f0f0f] px-3 py-2.5 text-left transition-colors hover:border-neutral-600 hover:bg-[#141414]"
                  >
                    <div className="text-[13px] font-medium text-neutral-200 group-hover:text-white">
                      {s.label}
                    </div>
                    <div className="mt-1 flex items-center justify-between gap-3">
                      <span className="text-[11px] text-neutral-600">{s.note}</span>
                      <span className="shrink-0 font-mono text-[10px] text-neutral-700 group-hover:text-blue-400">
                        去检索 →
                      </span>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {payload.advice && (
        <p className="mt-4 rounded-md border border-neutral-800 bg-[#0f0f0f] px-3 py-2 text-[12px] leading-relaxed text-neutral-400">
          {payload.advice}
        </p>
      )}

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-neutral-800 pt-3">
        <span className="font-mono text-[10px] tabular-nums text-neutral-700">
          窗口 {fmtDay(payload.timeRange.from)} → {fmtDay(payload.timeRange.to)} · 维度
          {payload.dimensions.length > 0 ? " " + payload.dimensions.join(" / ") : " 未定"} · 歧义{" "}
          {payload.ambiguity.toFixed(2)}
        </span>
        <button
          type="button"
          onClick={onDismiss}
          className="rounded-md px-2.5 py-1 text-[11px] text-neutral-500 transition-colors hover:text-white"
        >
          按现在的理解继续 →
        </button>
      </div>
    </section>
  );
}
