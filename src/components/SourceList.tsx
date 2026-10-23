"use client";

import { useState } from "react";
import type { SourceRef } from "@/lib/sse";
import BilingualCompare from "./BilingualCompare";
import Term from "./Glossary";

function timeAgo(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "—";
  const hours = Math.round((Date.now() - t) / 3_600_000);
  if (hours < 1) return "刚刚";
  if (hours < 24) return hours + " 小时前";
  return Math.round(hours / 24) + " 天前";
}

export default function SourceList({ sources }: { sources: SourceRef[] }) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [comparing, setComparing] = useState<string | null>(null);

  if (sources.length === 0) {
    return (
      <div className="px-6 py-4 text-[11px] text-neutral-500">
        没有可追溯的原文。按规则，此时不展示任何聚合数字。
      </div>
    );
  }

  return (
    <ul>
      {sources.map((s) => (
        <li key={s.id} className="px-6 py-2.5 transition-colors hover:bg-cyan-500/[0.04]">
          <div className="flex items-start gap-3">
            <span className="mt-1 h-1 w-1 shrink-0 rounded-sm bg-cyan-500/70 shadow-[0_0_6px_rgba(34,211,238,0.6)]" aria-hidden />
            <span className="mt-0.5 w-16 shrink-0 font-mono text-[10px] tabular-nums text-neutral-600">
              {timeAgo(s.publishedAt)}
            </span>
            <div className="min-w-0 flex-1">
              <a
                href={s.url}
                target="_blank"
                rel="noreferrer noopener"
                className="block truncate text-[13px] text-neutral-300 transition-colors hover:text-cyan-300"
                title={s.title}
              >
                {s.title}
              </a>
              <div className="mt-1 flex flex-wrap items-center gap-2 text-[10px] text-neutral-500">
                <span className="font-mono">{s.owner}</span>
                {s.syndicated && (
                  <span className="rounded border border-amber-400/25 bg-amber-400/10 px-2 py-0.5 text-amber-300">
                    <Term k="nSyndicated">疑似转载</Term>
                  </span>
                )}
                {s.quote && (
                  <button
                    type="button"
                    onClick={() => setExpanded(expanded === s.id ? null : s.id)}
                    className="rounded border border-white/10 bg-white/10 px-2 py-0.5 text-neutral-300 transition-colors hover:border-cyan-500/40 hover:text-white"
                  >
                    原文片段
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setComparing(comparing === s.id ? null : s.id)}
                  className={
                    "rounded px-2 py-0.5 transition-colors " +
                    (comparing === s.id
                      ? "border border-cyan-400/50 bg-cyan-500/15 text-cyan-200"
                      : "border border-cyan-500/25 bg-cyan-500/[0.07] text-cyan-300/90 hover:border-cyan-400/50 hover:text-cyan-200")
                  }
                  title="抓取原文正文，逐段给出译文与可核对差异"
                >
                  对照原文
                </button>
              </div>
              {expanded === s.id && s.quote && (
                <blockquote className="mt-2 border-l-2 border-cyan-500/40 pl-3 text-[11px] leading-relaxed text-neutral-400">
                  {s.quote}
                </blockquote>
              )}
              {comparing === s.id && (
                <BilingualCompare url={s.url} title={s.title} text={s.quote} />
              )}
            </div>
          </div>
        </li>
      ))}
    </ul>
  );
}
