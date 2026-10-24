"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { motion } from "framer-motion";
import {
  Activity as ActivityIcon,
  ArrowDown,
  RotateCcw,
  Settings as SettingsIcon,
} from "lucide-react";
import { useProbe, type ModuleState } from "@/hooks/useProbe";
import type { TrendingSnapshot } from "@/lib/trending";
import SearchBar from "./SearchBar";
import FeedbackButton from "./FeedbackButton";
import { VERSION_LABEL } from "@/lib/version";
import ModuleGrid from "./ModuleGrid";
import EntityGraphCard from "./EntityGraphCard";
import ClarifyCard from "./ClarifyCard";
import SourceList from "./SourceList";
import ConfidenceBadge from "./ConfidenceBadge";
import ProbeLogo from "./ProbeLogo";
import TrendingBoard from "./TrendingBoard";
import Term from "./Glossary";
import SettingsPanel from "./SettingsPanel";
import ModuleDock from "./ModuleDock";
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

/**
 * 布局动效的唯一参数。写在这里是为了首页与结果页共用同一条曲线：
 * 从「居中大锁标 + 大输入行」到「顶栏小锁标 + 一行输入」是同一个元素在移动，
 * 不是两个页面在切换 —— 所以两处必须同频，否则会看成两次跳转。
 */
const SPRING = { type: "spring", stiffness: 260, damping: 30, mass: 0.9 } as const;

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
  if (suffix === "failed") return name + "（请求失败）";
  if (suffix === "not_configured") return name + "（未接入）";
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
  const { state, run, reset, addModule } = useProbe();
  const [input, setInput] = useState(initialQuery);
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const running = state.status === "running";
  const booted = useRef(false);
  const datasets = useMemo(() => datasetsFromModules(state.modules), [state.modules]);
  // 生成器只属于「结果页」：跑完、且真有可出图的数据集，才给它一个位置。
  const diyReady = state.status === "done" && datasets.length > 0;

  /** 歧义卡被手动关掉的那一轮的查询词：只藏这一轮，换查询重新给机会。 */
  const [clarifyHidden, setClarifyHidden] = useState<string | null>(null);

  /** 图表「收起全部」：网格内的卡由 ModuleGrid 自己管，实体关系图在网格外，靠这个开关同步。 */
  const [graphCollapsed, setGraphCollapsed] = useState(false);

  /**
   * isSearched = 用户已经问过一次。
   *
   * 不用单独的 useState：状态源头在 useProbe 里（idle → running → done/failed），
   * 再存一份布尔就会出现"两处各记一次"的漂移。idle 就是首页，其余都是结果页。
   * 输入框的值仍在 input 里，跑过的查询在 state.query 里（布局快照按它做键）。
   */
  const searched = state.status !== "idle";

  /**
   * 设置里的 key 要跟着请求走，而 boot / 点话题这两条路径都写在闭包里，
   * 所以除了 state 再存一份 ref：回调里读 ref 拿到的一定是最新值，
   * 又不必把 settings 塞进依赖数组（否则改个字号就会重发查询）。
   */
  const settingsRef = useRef<Settings>(DEFAULT_SETTINGS);

  const runWithSettings = (q: string) => run(q, settingsHeaders(settingsRef.current));

  /** 最新的 run：popstate 之类的监听器不能闭包住第一次渲染时的函数。 */
  const runRef = useRef(runWithSettings);
  runRef.current = runWithSettings;

  // 先读设置再自动查询：两个 effect 按声明顺序执行，boot 时 ref 已就绪。
  useEffect(() => {
    const s = readSettings();
    settingsRef.current = s;
    setSettings(s);
    applySettings(s);
  }, []);

  /**
   * 返回是否真的写进了本机：配额满 / 隐私模式下 setItem 会抛，
   * 面板据此提示"只在本次会话生效"，而不是继续写着"只存本机"。
   * 即时生效与"存没存住"是两件事，所以先 apply 再返回结果。
   */
  const updateSettings = (next: Settings): boolean => {
    settingsRef.current = next;
    setSettings(next);
    const saved = writeSettings(next);
    applySettings(next);
    return saved;
  };

  /**
   * 顶部锁标 / 「新建搜索」共用：清空输入、中止流、回到首页态。
   * 不刷新页面 —— 这正是这次改造的重点：状态归零靠 React，不靠一次整页重载。
   */
  /**
   * 地址栏跟查询走：检索是 pushState（所以后退能回到上一个结果），
   * 回首页是 replaceState（不想要一串空查询的历史记录）。
   * 自己 push 不会触发 popstate —— 事件只在前进/后退时来，因此不会自我重跑。
   */
  const syncUrl = useCallback((q: string | null, mode: "push" | "replace") => {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    if (q) url.searchParams.set("q", q);
    else url.searchParams.delete("q");
    if (mode === "push") window.history.pushState(null, "", url.toString());
    else window.history.replaceState(null, "", url.toString());
  }, []);

  const newSearch = useCallback(() => {
    setInput("");
    reset();
    setGraphCollapsed(false);
    syncUrl(null, "replace");
    if (typeof window !== "undefined") window.scrollTo({ top: 0, behavior: "smooth" });
  }, [reset, syncUrl]);

  const logoRef = useRef<HTMLDivElement | null>(null);
  const logoBtnRef = useRef<HTMLButtonElement | null>(null);
  const logoPopTimer = useRef<number | null>(null);

  /**
   * 点一下锁标，把「画线 → 节点依次落位」重播一遍。
   * 类名没变 CSS 动画就不会重来，所以必须摘掉 → 强制回流 → 挂回。
   * 三步放在同一个任务里：浏览器来不及画中间态，看不到闪烁。
   * 回弹挂在 button 上而不是外层 motion.div —— 那条 div 的 transform
   * 归 framer-motion 的 layout 动画管，两套动画抢同一个属性会互相打断。
   */
  const replayLogo = useCallback(() => {
    const host = logoRef.current;
    if (!host) return;
    host.classList.remove("logo-anim");
    void host.offsetWidth;
    host.classList.add("logo-anim");

    const btn = logoBtnRef.current;
    if (!btn) return;
    btn.classList.remove("logo-pop");
    void btn.offsetWidth;
    btn.classList.add("logo-pop");
    if (logoPopTimer.current !== null) window.clearTimeout(logoPopTimer.current);
    logoPopTimer.current = window.setTimeout(() => {
      btn.classList.remove("logo-pop");
      logoPopTimer.current = null;
    }, 340);
  }, []);

  useEffect(
    () => () => {
      if (logoPopTimer.current !== null) window.clearTimeout(logoPopTimer.current);
    },
    [],
  );

  // 从首页进入结果页时把视口拉回顶部，否则「锁标上推」这段动画有一半在屏幕外。
  useEffect(() => {
    if (searched && typeof window !== "undefined") window.scrollTo({ top: 0 });
  }, [searched]);

  // 热榜点话题：填词、跑查询、同步 URL 要一起做，
  // 否则刷新后回不到刚才那个结果。
  /**
   * 从界面发起的检索只有这一条路：跑查询 + 把这一次写进历史。
   * 输入框回车与点热榜话题都要 push —— 否则后退键回到的是「上一个页面」，
   * 而不是上一个结果（replaceState 不产生历史项，这是它的定义）。
   */
  const startSearch = useCallback(
    (q: string) => {
      const trimmed = q.trim();
      if (!trimmed) return;
      setInput(trimmed);
      runRef.current(trimmed);
      syncUrl(trimmed, "push");
    },
    [syncUrl],
  );

  const pickTopic = (name: string) => startSearch(name);

  /** 浏览器后退 / 前进时按地址栏那一次查询重跑。 */
  useEffect(() => {
    const onPop = () => {
      const q = new URL(window.location.href).searchParams.get("q");
      if (!q) {
        setInput("");
        reset();
        return;
      }
      setInput(q);
      runRef.current(q);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [reset]);

  const scrollToTrending = () => {
    document.getElementById("trending")?.scrollIntoView({ behavior: "smooth", block: "start" });
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
      className="flex h-10 w-10 items-center justify-center rounded-md text-neutral-600 transition-colors hover:text-neutral-300 sm:h-9 sm:w-9"
      aria-haspopup="dialog"
      aria-label="设置"
      title="设置"
    >
      <SettingsIcon aria-hidden className="h-[15px] w-[15px]" strokeWidth={1.25} />
    </button>
  );

  const metricsLink = (
    <Link
      href="/metrics"
      className="flex min-h-10 items-center gap-1.5 rounded-md px-2 font-mono text-[11px] text-neutral-500 transition-colors hover:text-white sm:min-h-9"
    >
      <ActivityIcon aria-hidden className="h-[13px] w-[13px]" strokeWidth={1.5} />
      运行指标
    </Link>
  );

  return (
    <main className="safe-x relative mx-auto flex w-full max-w-[1560px] flex-col sm:[--safe-pad:2rem]">
      {/*
        首页是封面，没有顶栏 —— 设置和指标就都收在右上角这一行。
        只放图标按钮的话没人找得到设置，所以指标带文字、齿轮带 title。
      */}
      {!searched && (
        <div className="safe-x absolute right-0 top-[max(0.5rem,env(safe-area-inset-top))] z-10 flex items-center gap-1 sm:[--safe-pad:1.5rem]">
          {metricsLink}
          {settingsButton}
        </div>
      )}
      {/*
        同一个容器承担两种形态：首页是占满首屏的竖排入口，结果页是顶部一行。
        用 framer-motion 的 layout 而不是两套 DOM —— 元素只有一个，
        位置和尺寸的变化由它自己插值，中途不会闪、也不会重建 ECharts。
      */}
      <motion.div
        layout
        transition={SPRING}
        className={
          searched
            ? "flex flex-wrap items-center gap-x-4 gap-y-3 border-b border-neutral-800 py-4"
            : "flex min-h-[calc(100svh-5.5rem)] flex-col items-center justify-center gap-7 pb-14 pt-6"
        }
      >
        <motion.div
          layout
          transition={SPRING}
          ref={logoRef}
          className={searched ? "logo-anim shrink-0" : "logo-anim flex justify-center"}
        >
          <button
            ref={logoBtnRef}
            type="button"
            onClick={() => {
              replayLogo();
              if (searched) newSearch();
            }}
            aria-label={searched ? "回到首页" : "重播 Logo 动画"}
            title={searched ? "回到首页（会重播一次 Logo）" : "点一下，重播 Logo 动画"}
            className="flex cursor-pointer items-center"
          >
            <ProbeLogo
              orientation={searched ? "horizontal" : "vertical"}
              size={searched ? 22 : "clamp(30px,4vw,56px)"}
              subtitle={null}
            />
          </button>
        </motion.div>

        {/* 只在首页出现的一行标语：结果页顶栏里再放一句口号就成装饰了。
            中英各一句，间距按字宽分开调：拉丁句拉开 0.12em 就够，汉字在同一档里
            会显得挤，配 0.26em；汉字尾部多出一个字距，补等量负边距才真正居中。 */}
        {!searched && (
          <motion.p
            layout
            transition={SPRING}
            className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1.5 text-neutral-600"
          >
            <span className="font-mono text-[11px] tracking-[0.12em] text-neutral-600">
              Micro in, Macro out
            </span>
            <span aria-hidden className="h-3 w-px bg-neutral-800" />
            {/* 汉字在 11px 上本来就比拉丁字母压得住，所以让它是两级里更亮的那个：
                这里的主读者是中文，拉丁半句是呼应不是主角。 */}
            <span className="-mr-[0.26em] text-[11px] tracking-[0.26em] text-neutral-500">见微，知著</span>
          </motion.p>
        )}

        <motion.div
          layout
          transition={SPRING}
          className={searched ? "min-w-0 flex-1 basis-[240px]" : "w-full max-w-[720px]"}
        >
          <SearchBar
            running={running}
            value={input}
            onChange={setInput}
            onRun={startSearch}
            size={searched ? "sm" : "lg"}
          />
        </motion.div>

        {searched && (
          <div className="flex shrink-0 items-center gap-1.5">
            {state.confidence && <ConfidenceBadge confidence={state.confidence} />}
            <button
              type="button"
              onClick={newSearch}
              aria-label="新建搜索"
              title="新建搜索"
              className="flex items-center gap-1.5 rounded-md px-2 py-1.5 font-mono text-[11px] text-neutral-500 transition-colors hover:text-white"
            >
              <RotateCcw aria-hidden className="h-3.5 w-3.5" strokeWidth={1.5} />
              新建搜索
            </button>
            {/* 窄屏顶栏一行放不下四件东西，指标在手机上退回页脚那一个入口。 */}
            <span className="hidden sm:flex">{metricsLink}</span>
            {settingsButton}
          </div>
        )}

        {!searched && (
          <motion.button
            layout
            transition={SPRING}
            type="button"
            onClick={scrollToTrending}
            className="flex items-center gap-1.5 text-xs text-neutral-600 transition-colors hover:text-neutral-300"
          >
            不看提问，先看今天的 24 小时热点
            <ArrowDown
              aria-hidden
              className="h-3.5 w-3.5 animate-bounce motion-reduce:animate-none"
              strokeWidth={1.5}
            />
          </motion.button>
        )}
      </motion.div>

      {searched && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.28, delay: 0.06 }}
          className="flex flex-col gap-6 pt-6"
        >
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
            歧义澄清：紧贴意图条，因为它在解释「我刚把这句话理解成了什么」。
            关掉只藏这一轮 —— 下一次查询是另一句话，可能又有别的读法。
          */}
          {state.clarify && clarifyHidden !== state.query && (
            <ClarifyCard
              payload={state.clarify}
              onPick={pickTopic}
              onDismiss={() => setClarifyHidden(state.query)}
            />
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
              {/*
                摘要：这是流式输出的落点。文字本身由 useProbe 按帧合帧追加，
                这里只负责「有第一段字时才淡入」，避免留一个空盒子在等。
              */}
              {state.text && (
                <motion.div
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.32, ease: "easeOut" }}
                  className="panel p-6"
                >
                  <p className="whitespace-pre-wrap text-sm leading-7 text-neutral-300">
                    {state.text}
                    {running && <span className="caret" />}
                  </p>
                </motion.div>
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
                  onCollapseAll={setGraphCollapsed}
                />
              )}

              {/*
                共现图放在面板与信源之间：它既解释「面板里那些词为什么一起出现」，
                又需要下方的信源来当证据，所以在阅读顺序上正好夹在中间。
              */}
              {state.entityGraph && (
                <EntityGraphCard
                  graph={state.entityGraph}
                  sources={state.sources}
                  collapsed={graphCollapsed}
                  onToggle={() => setGraphCollapsed((v) => !v)}
                />
              )}

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

              {/*
                口径说明：服务端一直在算这些（抑制了哪些数字、去重合并了几条、
                "文章数"到底指什么），但以前只写进服务端 notes，用户一句也看不到。
                用中性色而不是警示色 —— 它们是解释，不是故障。
              */}
              {state.status === "done" && state.notes.length > 0 && (
                <div className="rounded-md border border-neutral-800 px-4 py-3 text-[10px] leading-relaxed text-neutral-500">
                  <span className="text-neutral-400">口径</span>
                  <ul className="mt-1 flex flex-col gap-1">
                    {state.notes.map((n) => (
                      <li key={n}>{n}</li>
                    ))}
                  </ul>
                </div>
              )}

              {state.status === "done" && state.degraded.length > 0 && (
                <div className="rounded-md border border-yellow-500/25 bg-yellow-500/[0.05] px-4 py-3 text-[10px] leading-relaxed text-yellow-500/90">
                  <Term k="degraded">降级项</Term>：
                  {state.degraded.map(degradeText).join(" · ")}
                  （这些来源本轮不可用或已退回本地样本，结论已相应收缩）
                </div>
              )}

              {/* 本轮统计行。用 div 不用 footer：页面上只留一个 footer 地标（在页面最底下）。 */}
              {state.status === "done" && state.elapsedMs !== null && (
                <div className="flex flex-wrap gap-x-6 gap-y-1.5 px-1 pt-2 font-mono text-[10px] tabular-nums text-neutral-600">
                  <span>耗时 {state.elapsedMs} ms</span>
                  <span>模块 {state.modules.length} 个</span>
                  <span>信源 {state.sources.length} 条</span>
                  {state.confidence && (
                    <span>
                      <Term k="independence">独立稿源</Term> {state.confidence.nOwners} 个
                    </span>
                  )}
                  <span className="text-neutral-700">无源不显示 · 缺失不填 0</span>
                </div>
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
        </motion.div>
      )}

      {/* 首页的第二屏：热榜。发起检索后收起 —— 结果页要专注，不靠猜你还在看榜。 */}
      {!searched && (
        <section id="trending" className="scroll-mt-6 border-t border-neutral-800 pb-16 pt-8">
          {trending ? (
            <TrendingBoard snapshot={trending} onPick={pickTopic} />
          ) : (
            <p className="text-[11px] text-neutral-600">
              本轮没有取到热榜数据 —— 在上面输入一个问题就能开始。
            </p>
          )}
        </section>
      )}

      {/*
        页脚：反馈与指标页一起沉到最底下。
        这两件事都不是主流程 —— 想找它们的人已经在往下翻了；放在顶上只会跟搜索框抢注意力。
        查询词一并带进反馈里，作者复现时不用问「你当时搜的什么」。
      */}
      <footer className="mt-2 flex flex-wrap items-center justify-between gap-3 border-t border-neutral-800 px-1 py-5">
        <span className="font-mono text-[10px] text-neutral-700">
          探针 <span className="text-neutral-600">{VERSION_LABEL}</span>
          {searched && state.query ? " · 本轮查询「" + state.query + "」" : ""}
        </span>
        <div className="flex items-center gap-3">
          <Link
            href="/metrics"
            className="flex min-h-8 items-center font-mono text-[10px] text-neutral-600 transition-colors hover:text-neutral-300 sm:min-h-0"
          >
            运行指标 →
          </Link>
          <FeedbackButton query={searched ? state.query : input.trim()} />
        </div>
      </footer>

      <SettingsPanel
        open={settingsOpen}
        settings={settings}
        onChange={updateSettings}
        onClose={() => setSettingsOpen(false)}
      />
    </main>
  );
}
