
"use client";

import { useEffect, useRef } from "react";
import { useProbe } from "@/hooks/useProbe";
import SearchBar from "./SearchBar";
import ModuleCard from "./ModuleCard";
import SourceList from "./SourceList";
import ConfidenceBadge from "./ConfidenceBadge";

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

export default function Workspace({ initialQuery = "" }: { initialQuery?: string }) {
  const { state, run } = useProbe();
  const running = state.status === "running";
  const booted = useRef(false);

  // StrictMode 下 effect 会跑两次，用 ref 保证自动查询只发一次。
  useEffect(() => {
    if (booted.current || !initialQuery.trim()) return;
    booted.current = true;
    void run(initialQuery);
  }, [initialQuery, run]);

  return (
    <main className="relative z-10 mx-auto flex min-h-screen max-w-[1180px] flex-col gap-4 px-4 py-8">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="flex items-baseline gap-2">
            <h1 className="text-lg tracking-[0.2em] text-[#e2e8f0]">探针</h1>
            <span className="text-[10px] uppercase tracking-[0.3em] text-[#3f4854]">probe</span>
          </div>
          <p className="mt-1 text-[11px] text-[#5c6675]">
            高置信度情报终端 · 无源不显示 · 缺失不填 0
          </p>
        </div>
        {state.confidence && <ConfidenceBadge confidence={state.confidence} />}
      </header>

      <SearchBar running={running} onRun={run} />

      {state.intent && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-l-2 border-[#5eead4]/30 pl-3 text-[10px] text-[#5c6675]">
          <span>意图：{KIND_TEXT[state.intent.kind] ?? state.intent.kind}</span>
          <span>
            实体：
            {state.intent.entities.length > 0
              ? state.intent.entities.map((e) => e.name).join(" / ")
              : "未识别"}
          </span>
          <span>窗口：{fmtDay(state.intent.timeRange.from)} → {fmtDay(state.intent.timeRange.to)}</span>
          <span>歧义度：{state.intent.ambiguity.toFixed(2)}</span>
        </div>
      )}

      {state.status === "idle" && (
        <div className="panel mt-2 px-4 py-10 text-center">
          <p className="text-[12px] text-[#5c6675]">
            输入一个需要证据的问题。系统会先做多源检索，再决定生成哪些面板。
          </p>
          <p className="mt-2 text-[11px] text-[#3f4854]">
            未配置 API key 也能跑通全链路：Hacker News 与 Wikipedia 免密钥可用，
            其余来源视网络情况而定，抽不到证据时展示本地演示样本并明确标注。
          </p>
        </div>
      )}

      {state.text && (
        <div className="panel px-4 py-3">
          <p className="whitespace-pre-wrap text-[12px] leading-[1.85] text-[#b9c4d2]">
            {state.text}
            {running && <span className="caret" />}
          </p>
        </div>
      )}

      {running && state.modules.length === 0 && (
        <div className="text-[11px] text-[#5c6675]">正在检索多源…</div>
      )}

      {state.modules.length > 0 && (
        <div className="module-grid">
          {state.modules.map((m) => (
            <div key={m.id} style={{ gridColumn: "span " + m.w }}>
              <ModuleCard module={m} sources={state.sources} />
            </div>
          ))}
        </div>
      )}

      {state.sources.length > 0 && (
        <section className="panel">
          <header className="flex items-center justify-between border-b border-white/6 px-3 py-2">
            <span className="text-[12px] text-[#cbd5e1]">原始信源 · {state.sources.length}</span>
            <span className="text-[10px] text-[#3f4854]">点开即原文</span>
          </header>
          <div className="scroll-thin max-h-[340px] overflow-auto">
            <SourceList sources={state.sources} />
          </div>
        </section>
      )}

      {state.status === "done" && state.degraded.length > 0 && (
        <div className="rounded border border-[#fbbf24]/20 bg-[#fbbf24]/5 px-3 py-2 text-[10px] text-[#fbbf24]/85">
          降级项：
          {state.degraded.map(degradeText).join(" · ")}
          （这些来源本轮不可用或已退回本地样本，结论已相应收缩）
        </div>
      )}

      {state.status === "done" && state.elapsedMs !== null && (
        <footer className="flex flex-wrap gap-4 border-t border-white/6 pt-3 text-[10px] text-[#3f4854]">
          <span>耗时 {state.elapsedMs} ms</span>
          <span>模块 {state.modules.length} 个</span>
          <span>信源 {state.sources.length} 条</span>
          {state.confidence && <span>独立稿源 {state.confidence.nOwners} 个</span>}
        </footer>
      )}

      {state.status === "failed" && (
        <div className="rounded border border-[#fb7185]/25 bg-[#fb7185]/6 px-3 py-2 text-[11px] text-[#fb7185]">
          请求失败：{state.error}
        </div>
      )}
    </main>
  );
}
