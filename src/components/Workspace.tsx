"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useProbe, type ModuleState } from "@/hooks/useProbe";
import type { TrendingSnapshot } from "@/lib/trending";
import SearchBar from "./SearchBar";
import ModuleGrid from "./ModuleGrid";
import EntityGraphCard from "./EntityGraphCard";
import SourceList from "./SourceList";
import ConfidenceBadge from "./ConfidenceBadge";
import ProbeLogo from "./ProbeLogo";
import TrendingBoard from "./TrendingBoard";
import Term from "./Glossary";
import SettingsPanel from "./SettingsPanel";
import ModuleDock from "./ModuleDock";
import LandingHero from "./LandingHero";
import type { Dataset } from "@/lib/schemas";
import {
  DEFAULT_SETTINGS,
  GRID_GAP,
  applySettings,
  readSettings,
  settingsHeaders,
  writeSettings,
  type Settings,
} from "@/lib/settings";

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

/**
 * 从已就绪的卡片里重建数据集清单。
 *
 * 「一句话生成模块」要知道这一轮有哪几份数据、每份有哪些字段。流水线没有单独
 * 发数据集事件，但 module.ready 里带着这份数据的 rows / fields —— 当前实现里
 * module 与 dataset 是一对一的，按 dataset id 去重就够了。
 */
function datasetsFromModules(modules: ModuleState[]): Dataset[] {
  const seen = new Set<string>();
  const out: Dataset[] = [];
  for (const m of modules) {
    const id = m.spec?.dataset;
    if (!id || seen.has(id)) continue;
    if (!m.fields || m.fields.length === 0 || !m.rows || m.rows.length === 0) continue;
    seen.add(id);
    out.push({ id, name: m.datasetName ?? id, fields: m.fields, rows: m.rows });
  }
  return out;
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
  const { state, run, addModule } = useProbe();
  const [input, setInput] = useState(initialQuery);
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const running = state.status === "running";
  const booted = useRef(false);
  const datasets = useMemo(() => datasetsFromModules(state.modules), [state.modules]);
  // 生成器只属于「结果页」：跑完、且真有可出图的数据集，才给它一个位置。
  const diyReady = state.status === "done" && datasets.length > 0;
  /** 还没问过 = 首页（搜索入口）；一旦发起检索就进结果页，热榜退到首页的下一屏。 */
  const landing = state.status === "idle";

  /**
   * 设置里的 key 要跟着请求走，而 boot / 点话题这两条路径都写在闭包里，
   * 所以除了 state 再存一份 ref：回调里读 ref 拿到的一定是最新值，
   * 又不必把 settings 塞进依赖数组（否则改个字号就会重发查询）。
   */
  const settingsRef = useRef<Settings>(DEFAULT_SETTINGS);

  const runWithSettings = (q: string) => run(q, settingsHeaders(settingsRef.current));

  // 先读设置再自动查询：两个 effect 按声明顺序执行，boot 时 ref 已就绪。
  useEffect(() => {
    const s = readSettings();
    settingsRef.current = s;
    setSettings(s);
    applySettings(s);
  }, []);

  const updateSettings = (next: Settings) => {
    settingsRef.current = next;
    setSettings(next);
    writeSettings(next);
    applySettings(next);
  };

  // 热榜点话题：填词、跑查询、同步 URL 要一起做，
  // 否则刷新后回不到刚才那个结果。
  const pickTopic = (name: string) => {
    setInput(name);
    runWithSettings(name);
    if (typeof window !== "undefined") {
      const url = new URL(window.location.href);
      url.searchParams.set("q", name);
      window.history.replaceState(null, "", url.toString());
    }
  };

  /**
   * 新面板插进网格之后把视线带过去：滚到它、闪 1.4 秒。
   * 加卡片和点「去看看」可能在同一帧里发生，所以查不到元素就等下一帧再试一次。
   */
  const revealModule = (id: string) => {
    const reveal = () => {
      const el = document.querySelector('[data-module-id="' + id + '"]');
      if (!el) return false;
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      el.classList.add("card-flash");
      window.setTimeout(() => el.classList.remove("card-flash"), 1400);
      return true;
    };
    if (!reveal()) window.requestAnimationFrame(reveal);
  };

  // StrictMode 下 effect 会跑两次，用 ref 保证自动查询只发一次。
  useEffect(() => {
    if (booted.current || !initialQuery.trim()) return;
    booted.current = true;
    runWithSettings(initialQuery);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialQuery]);

  const settingsButton = (
    <button
      type="button"
      onClick={() => setSettingsOpen(true)}
      className="flex items-center gap-1.5 rounded-md border border-neutral-800 px-3 py-1.5 font-mono text-[11px] text-neutral-400 transition-colors hover:border-neutral-600 hover:text-white"
      aria-haspopup="dialog"
    >
      <span aria-hidden className="text-neutral-600">
        ⚙
      </span>
      设置
    </button>
  );

  if (landing) {
    return (
      <>
        <main className="mx-auto flex w-full max-w-[1560px] flex-col px-5 sm:px-8">
          <div className="flex items-center justify-end pt-5">{settingsButton}</div>
          <LandingHero
            running={running}
            value={input}
            onChange={setInput}
            onRun={runWithSettings}
            hasTrending={Boolean(trending)}
          />
          <section id="trending" className="scroll-mt-6 border-t border-neutral-800 pb-16 pt-8">
            {trending ? (
              <TrendingBoard snapshot={trending} onPick={pickTopic} />
            ) : (
              <p className="text-[11px] text-neutral-600">
                本轮没有取到热榜数据 —— 在上面输入一个问题就能开始。
              </p>
            )}
          </section>
        </main>
        <SettingsPanel
          open={settingsOpen}
          settings={settings}
          onChange={updateSettings}
          onClose={() => setSettingsOpen(false)}
        />
      </>
    );
  }

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-[1560px] flex-col gap-6 px-5 py-8 sm:px-8">
      {/* 一条细线切出功能区：上面只有身份与状态，下面是输入与结果。
          锁标钉在左上角，工具靠右；一行放不下时自动折成两行。 */}
      <header className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3 border-b border-neutral-800 pb-5">
        <a href="/" aria-label="回到首页" className="flex items-center">
          <ProbeLogo size={28} />
        </a>
        <div className="flex items-center gap-3">
          {state.confidence && <ConfidenceBadge confidence={state.confidence} />}
          {settingsButton}
        </div>
      </header>

      <SearchBar running={running} value={input} onChange={setInput} onRun={runWithSettings} />

      {state.intent && (
        <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5 rounded-md border border-neutral-800 bg-[#0f0f0f] px-4 py-2.5 font-mono text-[10px] text-neutral-500">
          <span className="text-blue-500">
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

      {/*
        两列：结果区在左，生成器固定在右。侧栏从 xl 起才是常驻的（1024–1279 之间
        左列会被挤到 720px 的网格下限以下，那时把生成器放到结果下方更合适）。
      */}
      <div
        className={
          "grid grid-cols-1 items-start gap-6 " +
          (diyReady ? "xl:grid-cols-[minmax(0,1fr)_340px]" : "")
        }
      >
        <div className="flex min-w-0 flex-col gap-6">

          {state.text && (
            <div className="panel p-6">
              <p className="whitespace-pre-wrap text-sm leading-7 text-neutral-300">
                {state.text}
                {running && <span className="caret" />}
              </p>
            </div>
          )}

          {running && state.modules.length === 0 && (
            <div className="flex items-center gap-2 px-1 font-mono text-[11px] text-neutral-500">
              <span className="h-1 w-1 animate-pulse bg-blue-500" />
              正在检索多源…
            </div>
          )}

          {state.modules.length > 0 && (
            <ModuleGrid
              modules={state.modules}
              sources={state.sources}
              query={state.query}
              running={running}
              animation={settings.animation}
              gap={settings.density === "compact" ? GRID_GAP.compact : GRID_GAP.normal}
            />
          )}

          {/*
            共现图放在面板与信源之间：它既解释「面板里那些词为什么一起出现」，
            又需要下方的信源来当证据，所以在阅读顺序上正好夹在中间。
          */}
          {state.entityGraph && <EntityGraphCard graph={state.entityGraph} sources={state.sources} />}

          {state.sources.length > 0 && (
            <section className="panel overflow-hidden">
              <header className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-5 pb-1 pt-4">
                <span className="text-sm font-semibold text-white">
                  原始信源
                  <span className="ml-2 font-mono text-xs font-bold tabular-nums text-blue-500">
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
            <div className="rounded-md border border-yellow-500/25 bg-yellow-500/[0.05] px-4 py-3 text-[10px] leading-relaxed text-yellow-500/90">
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
              <span className="text-neutral-700">无源不显示 · 缺失不填 0</span>
            </footer>
          )}

          {state.status === "failed" && (
            <div className="rounded-md border border-red-500/30 bg-red-500/[0.06] px-4 py-3 text-[11px] text-red-400">
              请求失败：{state.error}
            </div>
          )}
        </div>

        {/*
          侧栏只在「跑完且真有数据可出图」时出现：检索过程中连占位都不留
          （进度已经在左列，一个还不能用的入口只是噪音）。
          入口本身收在 DIY 浮层后面（portal + fixed，侧栏的 overflow 裁不到它）。
        */}
        {diyReady && (
          <aside className="rise flex flex-col gap-4 xl:sticky xl:top-6 xl:self-start">
            <ModuleDock
              datasets={datasets}
              modules={state.modules}
              confidence={state.confidence?.score ?? 0}
              sourceIds={state.sources.slice(0, 20).map((s) => s.id)}
              headers={settingsHeaders(settings)}
              onAdd={addModule}
              onReveal={revealModule}
            />
          </aside>
        )}
      </div>

      <SettingsPanel
        open={settingsOpen}
        settings={settings}
        onChange={updateSettings}
        onClose={() => setSettingsOpen(false)}
      />
    </main>
  );
}
