"use client";

import { useEffect, useRef, useState } from "react";
import { useProbe } from "@/hooks/useProbe";
import type { TrendingSnapshot } from "@/lib/trending";
import SearchBar from "./SearchBar";
import ModuleGrid from "./ModuleGrid";
import SourceList from "./SourceList";
import ConfidenceBadge from "./ConfidenceBadge";
import TrendingBoard from "./TrendingBoard";
import Term from "./Glossary";

const KIND_TEXT: Record<string, string> = {
  lookup: "事实查询",
  exploratory: "探索分析",
  "no-panel": "需要澄清",
};

/**
 * degraded 里装的是给日志看的标识（gdelt、claims:off、window:dropped），
 * 直接拼给用户等于让他在界面上读我们的内部枚举。
 * 这里翻成人话，并保留"为什么没有"这一层信息。
 */
const PROVIDER_TEXT: Record<string, string> = {
  gdelt: "GDELT 新闻索引",
  hn: "Hacker News",
  wiki: "Wikipedia 浏览统计",
  tavily: "Tavily 网页检索",
  fixture: "本地演示样本",
  claims: "事实断言抽取",
  window: "时间窗过滤",
};

/** 意图里的时间窗是 ISO 时间戳，直接 slice(0,10) 拿到的是 UTC 日期。 */
function fmtDay(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
  return d.toLocaleDateString("sv-SE");
}

function degradeText(item: string): string {
  const i = item.indexOf(":");
  const base = i === -1 ? item : item.slice(0, i);
  const suffix = i === -1 ? "" : item.slice(i + 1);
  const name = PROVIDER_TEXT[base] ?? base;
  if (suffix === "empty") return name + "（本轮无命中）";
  if (suffix === "off") return name + "（未启用：缺少模型或密钥）";
  if (suffix === "dropped") return name + "（已丢弃）";
  if (suffix === "fixture") return name + "（已启用）";
  return name;
}

export default function Workspace({
  initialQuery = "",
  trending = null,
}: {
  initialQuery?: string;
  trending?: TrendingSnapshot | null;
}) {
  const { state, run } = useProbe();
  const [input, setInput] = useState(initialQuery);
  const running = state.status === "running";
  const booted = useRef(false);

  // 热榜点话题：填词、跑查询、同步 URL 要一起做，
  // 否则刷新后回不到刚才那个结果。
  const pickTopic = (name: string) => {
    setInput(name);
    void run(name);
    if (typeof window !== "undefined") {
      const url = new URL(window.location.href);
      url.searchParams.set("q", name);
      window.history.replaceState(null, "", url.toString());
    }
  };

  // StrictMode 下 effect 会跑两次，用 ref 保证自动查询只发一次。
  useEffect(() => {
    if (booted.current || !initialQuery.trim()) return;
    booted.current = true;
    void run(initialQuery);
  }, [initialQuery, run]);

  return (
    <main className="relative z-10 mx-auto flex min-h-screen w-full max-w-[1240px] flex-col gap-6 px-5 py-10 sm:px-8">
      <header className="flex flex-wrap items-end justify-between gap-6">
        <div>
          <div className="flex items-baseline gap-3.5">
            <h1 className="text-3xl font-black tracking-wider text-white">探针</h1>
            <span className="font-mono text-sm uppercase tracking-[0.3em] text-cyan-400">
              PROBE
            </span>
          </div>
          <p className="mt-2 text-sm text-neutral-400">
            高置信度情报终端 · 无源不显示 · 缺失不填 0
          </p>
        </div>
        {state.confidence && <ConfidenceBadge confidence={state.confidence} />}
      </header>

      {/* HUD 分隔线：从青色渐隐到透明，给标题区和数据区一道分界。 */}
      <div className="h-px w-full bg-gradient-to-r from-cyan-500/40 via-white/[0.06] to-transparent" />

      <SearchBar running={running} value={input} onChange={setInput} onRun={run} />

      {state.intent && (
        <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5 rounded-lg border border-cyan-500/20 bg-cyan-500/[0.04] px-4 py-2.5 font-mono text-[10px] text-neutral-400">
          <span className="text-cyan-400/90">
            意图 · {KIND_TEXT[state.intent.kind] ?? state.intent.kind}
          </span>
          <span>
            实体{" "}
            {state.intent.entities.length > 0
              ? state.intent.entities.map((e) => e.name).join(" / ")
              : "未识别"}
          </span>
          <span className="tabular-nums">
            <Term k="window">窗口</Term> {fmtDay(state.intent.timeRange.from)} →{" "}
            {fmtDay(state.intent.timeRange.to)}
          </span>
          <span className="tabular-nums">
            <Term k="ambiguity">歧义</Term> {state.intent.ambiguity.toFixed(2)}
          </span>
        </div>
      )}

      {state.status === "idle" && trending && (
        <TrendingBoard snapshot={trending} onPick={pickTopic} />
      )}

      {state.status === "idle" && !trending && (
        <div className="panel p-10 text-center">
          <p className="text-sm text-neutral-300">
            输入一个需要证据的问题。系统会先做多源检索，再决定生成哪些面板。
          </p>
          <p className="mx-auto mt-3 max-w-2xl text-[11px] leading-relaxed text-neutral-600">
            未配置 API key 也能跑通全链路：Hacker News 与 Wikipedia 免密钥可用，
            其余来源视网络情况而定，抽不到证据时展示本地演示样本并明确标注。
          </p>
        </div>
      )}

      {state.text && (
        <div className="panel p-6">
          <p className="whitespace-pre-wrap text-sm leading-7 text-neutral-200">
            {state.text}
            {running && <span className="caret" />}
          </p>
        </div>
      )}

      {running && state.modules.length === 0 && (
        <div className="flex items-center gap-2 px-1 font-mono text-[11px] text-neutral-500">
          <span className="h-1 w-1 animate-pulse rounded-sm bg-cyan-400 shadow-[0_0_8px_rgba(34,211,238,0.9)]" />
          正在检索多源…
        </div>
      )}

      {state.modules.length > 0 && (
        <ModuleGrid
          modules={state.modules}
          sources={state.sources}
          query={state.query}
          running={running}
        />
      )}

      {state.sources.length > 0 && (
        <section className="panel overflow-hidden">
          <header className="flex items-center justify-between px-6 pb-1 pt-5">
            <span className="text-sm font-semibold text-white">
              原始信源
              <span className="ml-2 font-mono text-xs font-bold tabular-nums text-cyan-400">
                {state.sources.length}
              </span>
            </span>
            <span className="font-mono text-[10px] text-neutral-600">
              点开即原文 · 「对照原文」给逐段双语对照
            </span>
          </header>
          <div className="scroll-thin max-h-[340px] overflow-auto pb-2">
            <SourceList sources={state.sources} />
          </div>
        </section>
      )}

      {state.status === "done" && state.degraded.length > 0 && (
        <div className="rounded-lg border border-amber-400/15 bg-amber-400/[0.06] px-4 py-3 text-[10px] leading-relaxed text-amber-300/85">
          <Term k="degraded">降级项</Term>：
          {state.degraded.map(degradeText).join(" · ")}
          （这些来源本轮不可用或已退回本地样本，结论已相应收缩）
        </div>
      )}

      {state.status === "done" && state.elapsedMs !== null && (
        <footer className="flex flex-wrap gap-x-6 gap-y-1.5 px-1 pt-2 font-mono text-[10px] tabular-nums text-neutral-600">
          <span>耗时 {state.elapsedMs} ms</span>
          <span>模块 {state.modules.length} 个</span>
          <span>信源 {state.sources.length} 条</span>
          {state.confidence && (
            <span>
              <Term k="independence">独立稿源</Term> {state.confidence.nOwners} 个
            </span>
          )}
        </footer>
      )}

      {state.status === "failed" && (
        <div className="rounded-lg border border-rose-500/20 bg-rose-500/[0.07] px-4 py-3 text-[11px] text-rose-400">
          请求失败：{state.error}
        </div>
      )}
    </main>
  );
}
