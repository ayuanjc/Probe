"use client";

import { memo } from "react";
import type { KeyFigure, KeyFiguresResult } from "@/lib/key-figures";
import type { SourceRef } from "@/lib/sse";

/**
 * 关键数字清单 —— 面板网格正下方那张表。
 *
 * 它的定位是「索引」不是「结论」：一行 = 一个数 + 它的原句 + 说过它的信源。
 * 所以界面上刻意不做的事：
 *   - 不排成排行榜（不按数值大小、不给第一名加粗），排序只看几家说过；
 *   - 不算任何汇总（不加总、不求均值），那是面板的事，而且要先过置信度闸门；
 *   - 不隐藏原句 —— 数字离开语境就成了另一种断言，原句放在指标名下面。
 * 点一行开的是**原文**，不是详情弹窗：核对数字只需要眼睛回到句子。
 */

const MODE_HINT: Record<KeyFiguresResult["mode"], string> = {
  claims: "数字来自本轮抽出的断言 · 每条都带原句",
  snippets: "数字由正则从原文句中搬运 · 未做交叉核对",
  "claims+snippets": "断言与原文句混排 · 带原句的那几条更可靠",
  none: "这轮没有可引用的数字",
};

function ownerOf(id: string, byId: Map<string, SourceRef>): string {
  return byId.get(id)?.owner ?? "";
}

function KeyFiguresTable({
  figures,
  sources,
  mode,
}: {
  figures: KeyFigure[];
  sources: SourceRef[];
  mode: KeyFiguresResult["mode"] | null;
}) {
  const byId = new Map(sources.map((s) => [s.id, s]));

  if (figures.length === 0) {
    return (
      <div className="px-5 py-4 text-[11px] leading-relaxed text-neutral-500">
        这轮命中的原文里没有出现带单位的数值。
        <span className="text-neutral-600">（没有数字就不摆一张空表，也不拿文字凑数。）</span>
      </div>
    );
  }

  return (
    <>
      <header className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-5 pb-1 pt-4">
        <span className="text-sm font-semibold text-white">
          关键数字
          <span className="ml-2 font-mono text-xs font-bold tabular-nums text-blue-500">
            {figures.length}
          </span>
        </span>
        <span className="font-mono text-[10px] text-neutral-600">
          {mode ? MODE_HINT[mode] : MODE_HINT.none} · 点行回原文
        </span>
      </header>

      <ul className="pb-2">
        {figures.map((f) => {
          const first = byId.get(f.sourceIds[0]);
          const owners = Array.from(new Set(f.sourceIds.map((id) => ownerOf(id, byId)).filter(Boolean)));
          const body = (
            <>
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span className="min-w-0 flex-1 truncate text-[13px] text-neutral-300" title={f.label}>
                  {f.label || "（原文未给指标名）"}
                </span>
                <span className="shrink-0 font-mono text-[15px] font-semibold tabular-nums text-white">
                  {f.value}
                </span>
              </div>
              {f.quote && (
                <p className="mt-1 line-clamp-2 text-[10px] leading-relaxed text-neutral-500">
                  「{f.quote}」
                </p>
              )}
              <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[10px] text-neutral-600">
                {f.period && <span className="text-neutral-500">{f.period}</span>}
                {owners.length > 0 && <span>{owners.slice(0, 3).join(" · ")}</span>}
                {f.sourceIds.length > 1 && (
                  <span className="text-blue-500">{f.sourceIds.length} 家提到</span>
                )}
              </div>
            </>
          );

          return (
            <li key={f.id} className="border-t border-neutral-800/60 first:border-t-0">
              {first ? (
                <a
                  href={first.url}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="block px-5 py-2.5 transition-colors hover:bg-neutral-800/40"
                  title={first.title}
                >
                  {body}
                </a>
              ) : (
                <div className="px-5 py-2.5">{body}</div>
              )}
            </li>
          );
        })}
      </ul>
    </>
  );
}

export default memo(KeyFiguresTable);
