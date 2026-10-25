"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Check, Clock3, Link2, Loader2, Plus, RotateCw, ShieldCheck, ShieldQuestion } from "lucide-react";

/**
 * 结果页左侧栏。
 *
 * 为什么要有它：一轮检索跑完，页面上依次是摘要、N 张面板、共现图、几十条信源、
 * 口径与统计 —— 全在一条滚动的单列里。以前要找「第三张图」只能滚，
 * 想回到上一次那个问题只能重打一遍。侧栏把三件事收在一处：
 *   1. **这一轮是什么**（查询词、意图、实体、时间窗、歧义度）；
 *   2. **去哪儿**（按区块跳转 + 面板清单，当前区块高亮跟随滚动）；
 *   3. **接下来做什么**（重跑、复制链接、新建搜索、去文档核验、最近查询）。
 *
 * 几条自我约束：
 * - 只做导航与动作，不重复正文。意图条在窄屏保留，在 lg 以上由侧栏接替（`lg:hidden`）。
 * - 不发明状态：当前区块靠 IntersectionObserver 读真实滚动位置，不做「点击后自说自话」。
 * - 没有的区块不出现。没出图就没有「共现图」，没信源就没有「信源」。
 * - 面板清单点一下等于滚到那张卡并闪一下 —— 与 ModuleDock 的「去看看」同一个动作。
 */

export type RailModule = {
  id: string;
  title: string;
  status: "plan" | "ready" | "error";
};

export type RailSection = { id: string; label: string; count?: number };

export type ResultRailProps = {
  query: string;
  running: boolean;
  kindLabel: string | null;
  entities: string[];
  windowLabel: string | null;
  ambiguity: number | null;
  modules: RailModule[];
  sourceCount: number;
  hasSummary: boolean;
  hasGraph: boolean;
  hasMeta: boolean;
  elapsedMs: number | null;
  history: string[];
  /**
   * 断言核验的摘要（null = 本轮没有可核的断言，入口不出现）。
   * 只放状态与一个数字：侧栏是目录，不是报告 —— 完整结论在页面上那张卡里。
   */
  evidence: {
    status: "idle" | "running" | "done" | "failed";
    agreement: number | null;
  } | null;
  onVerify: () => void;
  onPickQuery: (q: string) => void;
  onReRun: () => void;
  onNewSearch: () => void;
  onReveal: (moduleId: string) => void;
};

/** 区块清单：只列这一轮真实存在的区块，顺序与页面阅读顺序一致。 */
export function railSections(p: {
  hasSummary: boolean;
  modules: number;
  hasGraph: boolean;
  /** 有断言才有「断言核验」那一节 —— 没抽到断言的轮次点进去是空的。 */
  hasEvidence?: boolean;
  sources: number;
  hasMeta: boolean;
}): RailSection[] {
  const out: RailSection[] = [];
  if (p.hasSummary) out.push({ id: "sec-summary", label: "摘要" });
  if (p.modules > 0) out.push({ id: "sec-modules", label: "面板", count: p.modules });
  if (p.hasGraph) out.push({ id: "sec-graph", label: "共现图" });
  if (p.hasEvidence) out.push({ id: "sec-evidence", label: "断言核验" });
  if (p.sources > 0) out.push({ id: "sec-sources", label: "信源", count: p.sources });
  if (p.hasMeta) out.push({ id: "sec-meta", label: "口径与统计" });
  return out;
}

function jumpTo(id: string) {
  const el = document.getElementById(id);
  if (!el) return;
  el.scrollIntoView({ behavior: "smooth", block: "start" });
}

/**
 * 当前区块：以「视口上三分之一里最靠上的那个区块」为准。
 * 阈值放宽到 -15% / -70% 是因为结果页的区块高矮差得很远：
 * 摘要可能只有 200px，信源列表可能 3000px，用同一个判定自然就偏了。
 */
function useActiveSection(ids: string[]): string {
  const key = ids.join("|");
  const [active, setActive] = useState<string>(ids[0] ?? "");

  useEffect(() => {
    const list = key ? key.split("|") : [];
    const els = list
      .map((id) => document.getElementById(id))
      .filter((el): el is HTMLElement => el !== null);
    if (els.length === 0) return;

    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]) setActive(visible[0].target.id);
      },
      { rootMargin: "-15% 0px -70% 0px", threshold: 0 },
    );
    for (const el of els) observer.observe(el);
    return () => observer.disconnect();
  }, [key]);

  return active;
}

const STATUS_DOT: Record<RailModule["status"], string> = {
  ready: "bg-emerald-500",
  plan: "bg-blue-500 animate-pulse",
  error: "bg-red-500",
};

export default function ResultRail(props: ResultRailProps) {
  const [copied, setCopied] = useState(false);
  const sections = useMemo(
    () =>
      railSections({
        hasSummary: props.hasSummary,
        modules: props.modules.length,
        hasGraph: props.hasGraph,
        hasEvidence: props.evidence !== null,
        sources: props.sourceCount,
        hasMeta: props.hasMeta,
      }),
    [
      props.hasSummary,
      props.modules.length,
      props.hasGraph,
      props.evidence,
      props.sourceCount,
      props.hasMeta,
    ],
  );
  const active = useActiveSection(sections.map((s) => s.id));
  const shownEntities = props.entities.slice(0, 4);
  const restEntities = props.entities.length - shownEntities.length;

  useEffect(() => {
    if (!copied) return;
    const t = window.setTimeout(() => setCopied(false), 1600);
    return () => window.clearTimeout(t);
  }, [copied]);

  /** 最近列表里剔掉这一轮：正在看的那条不是「可以跳过去」的入口。 */
  const recent = props.history.filter((q) => q !== props.query);

  /** 复制失败（非 https、无剪贴板权限）时退回「把地址栏留给用户」：不报错，只是什么都不做。 */
  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <nav
      aria-label="本轮导航"
      className="rounded-md border border-neutral-800 bg-[#0f0f0f] p-3 font-mono text-[11px]"
    >
      {/* 本轮是什么 */}
      <div className="flex items-center gap-1.5 text-neutral-500">
        <span
          className={
            "h-1 w-1 rounded-full " + (props.running ? "animate-pulse bg-blue-500" : "bg-neutral-600")
          }
        />
        本轮
        {props.elapsedMs !== null && (
          <span className="ml-auto tabular-nums text-neutral-600">{props.elapsedMs}ms</span>
        )}
      </div>
      <p
        className="mt-1.5 line-clamp-3 text-[12px] leading-snug text-neutral-200"
        title={props.query}
      >
        {props.query || "（无查询词）"}
      </p>

      <div className="mt-2 flex flex-wrap gap-1 text-[10px]">
        {props.kindLabel && (
          <span className="rounded border border-neutral-800 px-1.5 py-0.5 text-blue-500">
            {props.kindLabel}
          </span>
        )}
        {props.windowLabel && (
          <span className="rounded border border-neutral-800 px-1.5 py-0.5 tabular-nums text-neutral-500">
            {props.windowLabel}
          </span>
        )}
        {props.ambiguity !== null && (
          <span
            className="rounded border border-neutral-800 px-1.5 py-0.5 tabular-nums text-neutral-500"
            title="意图歧义度：越高说明这句话不止一种读法"
          >
            歧义 {props.ambiguity.toFixed(2)}
          </span>
        )}
      </div>

      {shownEntities.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1 text-[10px]">
          {shownEntities.map((name) => (
            <span
              key={name}
              className="max-w-[7rem] truncate rounded bg-white/[0.04] px-1.5 py-0.5 text-neutral-400"
            >
              {name}
            </span>
          ))}
          {restEntities > 0 && (
            <span className="px-1 py-0.5 text-neutral-600">+{restEntities}</span>
          )}
        </div>
      )}

      {/* 去哪儿 */}
      {sections.length > 0 && (
        <ul className="mt-3 border-t border-neutral-800 pt-2">
          {sections.map((s) => (
            <li key={s.id}>
              <button
                type="button"
                onClick={() => jumpTo(s.id)}
                aria-current={active === s.id ? "true" : undefined}
                className={
                  "flex w-full items-center gap-2 border-l-2 py-1 pl-2 pr-1 text-left transition-colors " +
                  (active === s.id
                    ? "border-blue-500 bg-white/[0.03] text-white"
                    : "border-transparent text-neutral-500 hover:text-neutral-200")
                }
              >
                <span className="truncate">{s.label}</span>
                {typeof s.count === "number" && (
                  <span className="ml-auto tabular-nums text-neutral-600">{s.count}</span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}

      {/* 面板清单：点一下滚过去并闪一次，与卡片自己那条动效同源 */}
      {props.modules.length > 0 && (
        <div className="mt-2 border-t border-neutral-800 pt-2">
          <div className="flex items-center gap-1.5 text-[10px] text-neutral-600">
            面板
            <span className="tabular-nums">{props.modules.length}</span>
          </div>
          <ul className="mt-1 space-y-0.5">
            {props.modules.slice(0, 8).map((m) => (
              <li key={m.id}>
                <button
                  type="button"
                  onClick={() => props.onReveal(m.id)}
                  title={m.status === "error" ? m.title + "（出错了）" : m.title}
                  className="flex w-full items-center gap-2 rounded px-1 py-1 text-left text-[11px] text-neutral-400 transition-colors hover:bg-white/[0.04] hover:text-white"
                >
                  <span className={"h-1 w-1 shrink-0 rounded-full " + STATUS_DOT[m.status]} />
                  <span className="truncate">{m.title || "（无标题）"}</span>
                </button>
              </li>
            ))}
          </ul>
          {props.modules.length > 8 && (
            <p className="mt-1 px-1 text-[10px] text-neutral-600">还有 {props.modules.length - 8} 个，在页面上</p>
          )}
        </div>
      )}

      {/* 接下来做什么 */}
      <div className="mt-3 border-t border-neutral-800 pt-2">
        {props.evidence !== null && (
          <button
            type="button"
            onClick={props.onVerify}
            disabled={props.evidence.status === "running"}
            className="flex w-full items-center gap-2 rounded px-1 py-1.5 text-left text-neutral-400 transition-colors hover:bg-white/[0.04] hover:text-white disabled:opacity-50"
            title="逐条去本轮没引用过的来源里找证词（要跑十几次上游，几十秒）"
          >
            {props.evidence.status === "running" ? (
              <Loader2 aria-hidden className="h-3 w-3 shrink-0 animate-spin" strokeWidth={1.5} />
            ) : (
              <ShieldQuestion aria-hidden className="h-3 w-3 shrink-0" strokeWidth={1.5} />
            )}
            <span className="truncate">
              {props.evidence.status === "running"
                ? "正在核验…"
                : props.evidence.status === "failed"
                  ? "核验失败 · 再试"
                  : props.evidence.agreement !== null
                    ? "吻合度 " + Math.round(props.evidence.agreement * 100) + "%"
                    : "核验这一轮"}
            </span>
          </button>
        )}
        <button
          type="button"
          onClick={props.onReRun}
          disabled={props.running || !props.query}
          className="flex w-full items-center gap-2 rounded px-1 py-1.5 text-left text-neutral-400 transition-colors hover:bg-white/[0.04] hover:text-white disabled:opacity-40"
          title="用同样的查询词再跑一轮（换掉旧数据）"
        >
          <RotateCw aria-hidden className="h-3 w-3 shrink-0" strokeWidth={1.5} />
          重跑本轮
        </button>
        <button
          type="button"
          onClick={copyLink}
          className="flex w-full items-center gap-2 rounded px-1 py-1.5 text-left text-neutral-400 transition-colors hover:bg-white/[0.04] hover:text-white"
          title="复制这个结果的链接（地址栏里带着查询词）"
        >
          {copied ? (
            <Check aria-hidden className="h-3 w-3 shrink-0 text-emerald-500" strokeWidth={2} />
          ) : (
            <Link2 aria-hidden className="h-3 w-3 shrink-0" strokeWidth={1.5} />
          )}
          {copied ? "已复制" : "复制链接"}
        </button>
        <button
          type="button"
          onClick={props.onNewSearch}
          className="flex w-full items-center gap-2 rounded px-1 py-1.5 text-left text-neutral-400 transition-colors hover:bg-white/[0.04] hover:text-white"
        >
          <Plus aria-hidden className="h-3 w-3 shrink-0" strokeWidth={1.5} />
          新建搜索
        </button>
        <Link
          href="/verify"
          className="flex w-full items-center gap-2 rounded px-1 py-1.5 text-neutral-400 transition-colors hover:bg-white/[0.04] hover:text-white"
          title="拿一篇正文去做断言级核验"
        >
          <ShieldCheck aria-hidden className="h-3 w-3 shrink-0" strokeWidth={1.5} />
          文档核验
        </Link>
      </div>

      {/* 最近：只存查询词，点一下就是一次新检索（会 pushState，所以后退还能回来）。
          当前这轮不列进去 —— 把「你正在看的」当成「可以跳过去的」会点出一次无意义的重复检索。 */}
      {recent.length > 0 && (
        <div className="mt-2 border-t border-neutral-800 pt-2">
          <div className="flex items-center gap-1.5 text-[10px] text-neutral-600">
            <Clock3 aria-hidden className="h-2.5 w-2.5" strokeWidth={1.5} />
            最近
          </div>
          <ul className="mt-1 space-y-0.5">
            {recent.slice(0, 6).map((q) => (
              <li key={q}>
                <button
                  type="button"
                  onClick={() => props.onPickQuery(q)}
                  title={q}
                  className="w-full truncate rounded px-1 py-1 text-left text-[11px] text-neutral-500 transition-colors hover:bg-white/[0.04] hover:text-white"
                >
                  {q}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </nav>
  );
}

/**
 * 窄屏的替代品：一条吸顶的横向区块条。
 * 侧栏在手机上是灾难（它要么占掉半屏，要么藏在抽屉里没人打开），
 * 所以窄屏只留「跳转」这一件事，查询词和动作已经在你眼前。
 */
export function ResultJumpBar({ sections }: { sections: RailSection[] }) {
  const active = useActiveSection(sections.map((s) => s.id));
  if (sections.length === 0) return null;
  return (
    <div className="scroll-thin sticky top-0 z-20 -mx-1 flex gap-1 overflow-x-auto border-b border-neutral-800 bg-[#0a0a0a]/95 px-1 py-2 backdrop-blur lg:hidden">
      {sections.map((s) => (
        <button
          key={s.id}
          type="button"
          onClick={() => jumpTo(s.id)}
          className={
            "shrink-0 rounded border px-2 py-1 font-mono text-[10px] transition-colors " +
            (active === s.id
              ? "border-blue-500/40 bg-blue-500/10 text-blue-500"
              : "border-neutral-800 text-neutral-500")
          }
        >
          {s.label}
          {typeof s.count === "number" ? " " + s.count : ""}
        </button>
      ))}
    </div>
  );
}
