
"use client";

import { useState } from "react";
import type { SourceRef } from "@/lib/sse";

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

  if (sources.length === 0) {
    return (
      <div className="px-3 py-4 text-[11px] text-[#5c6675]">
        没有可追溯的原文。按规则，此时不展示任何聚合数字。
      </div>
    );
  }

  return (
    <ul className="divide-y divide-white/5">
      {sources.map((s) => (
        <li key={s.id} className="px-3 py-2">
          <div className="flex items-start gap-2">
            <span className="mt-1 shrink-0 text-[10px] text-[#3f4854]">{timeAgo(s.publishedAt)}</span>
            <div className="min-w-0 flex-1">
              <a
                href={s.url}
                target="_blank"
                rel="noreferrer noopener"
                className="block truncate text-[12px] text-[#cbd5e1] hover:text-[#5eead4]"
                title={s.title}
              >
                {s.title}
              </a>
              <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[10px] text-[#5c6675]">
                <span>{s.owner}</span>
                {s.syndicated && (
                  <span className="rounded border border-[#fbbf24]/30 px-1 text-[#fbbf24]">疑似转载</span>
                )}
                {s.quote && (
                  <button
                    type="button"
                    onClick={() => setExpanded(expanded === s.id ? null : s.id)}
                    className="rounded border border-white/10 px-1 text-[#94a3b8] hover:border-white/25"
                  >
                    原文片段
                  </button>
                )}
              </div>
              {expanded === s.id && s.quote && (
                <blockquote className="mt-1 border-l-2 border-[#5eead4]/40 pl-2 text-[11px] leading-relaxed text-[#94a3b8]">
                  {s.quote}
                </blockquote>
              )}
            </div>
          </div>
        </li>
      ))}
    </ul>
  );
}
