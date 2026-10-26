"use client";

import type { TrendingSnapshot, TrendingTopic } from "@/lib/trending";
import { HEAT_STATUS_CHIP, HEAT_STATUS_ORDER, HEAT_STATUS_TEXT } from "@/lib/heat-labels";
import Term from "./Glossary";

const TYPE_TEXT: Record<string, string> = {
  org: "机构",
  tech: "技术",
  event: "事件",
  person: "人物",
  place: "地点",
  product: "产品",
};

/** 徽章文案与配色在 src/lib/heat-labels.ts —— 两条轨（HN / 中文源）共用同一份。 */
const STATUS_TEXT = HEAT_STATUS_TEXT;
const STATUS_CHIP = HEAT_STATUS_CHIP;
const STATUS_ORDER = HEAT_STATUS_ORDER;

function fmtTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "未知";
  /**
   * 时区必须写死。这些时间戳是由服务端渲染进 HTML 的，
   * 不指定 timeZone 时 Node（部署机 UTC）与浏览器（+08:00）会算出两个不同的字符串，
   * 轻则水合警告，重则读者看到「更新于 11:30」而它其实是 19:30。
   */
  return d.toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Asia/Shanghai",
  });
}

/** 基线的日期区间只写月-日：年份在"过去 30 天"这个语境里是噪声。 */
function fmtDay(iso: string): string {
  if (!iso) return "—";
  return iso.slice(5).replace("-", "-");
}

/**
 * 火花线只用内联 SVG，不上 ECharts。
 * 首页有 12 张卡，为一条 14 点的折线各起一个 canvas 实例（含 zrender 初始化）
 * 会把首屏压到几十毫秒一帧；而这里要的只是"最近两周是什么形状"，一条 polyline 就够。
 * preserveAspectRatio="none" 让线随卡片宽度拉伸，所以描边必须 non-scaling-stroke，
 * 否则不同宽度下线条一个粗一个细。
 */
function Spark({ values }: { values: number[] }) {
  if (values.length < 3) return null;
  const W = 100;
  const H = 32;
  const max = Math.max(...values, 1);
  const step = W / (values.length - 1);
  const pts = values.map((v, i) => [i * step, H - (v / max) * (H - 6) - 3] as const);
  const line = pts.map((p) => p[0].toFixed(2) + "," + p[1].toFixed(2)).join(" ");
  return (
    <svg
      viewBox={"0 0 " + W + " " + H}
      preserveAspectRatio="none"
      className="h-9 w-full"
      role="img"
      aria-label={"近 " + values.length + " 天每日提及条数：" + values.join("、")}
    >
      <polygon points={"0," + H + " " + line + " " + W + "," + H} fill="rgba(59,130,246,0.08)" />
      <polyline
        points={line}
        fill="none"
        stroke="#3b82f6"
        strokeWidth={1}
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

/** 一格指标：标签在上、数字在下。横排逗号串读起来像日志，对齐成一列才像看板。 */
function Cell({
  label,
  value,
  accent,
}: {
  label: React.ReactNode;
  value: React.ReactNode;
  accent?: boolean;
}) {
  return (
    <div className="px-3 py-2">
      <div className="font-mono text-[9px] uppercase leading-none tracking-[0.12em] text-neutral-600">
        {label}
      </div>
      <div
        className={
          "mt-1.5 font-mono text-sm font-medium leading-none tabular-nums " +
          (accent ? "text-blue-400" : "text-white")
        }
      >
        {value}
      </div>
    </div>
  );
}

function TopicCard({
  topic,
  rank,
  onPick,
}: {
  topic: TrendingTopic;
  rank: number;
  onPick: (name: string) => void;
}) {
  const top = rank <= 3;
  return (
    <article className="group flex flex-col rounded-md border border-transparent bg-[#0c0c0c] p-5 transition-colors hover:border-neutral-700 sm:p-6">
      <div className="flex items-baseline gap-2.5">
        <span
          className={
            "font-mono text-[10px] font-medium tabular-nums " +
            (top ? "text-blue-500" : "text-neutral-700")
          }
        >
          {String(rank).padStart(2, "0")}
        </span>
        {/* 术语气泡不能塞进按钮里：pointer 事件会被按钮吃掉，点它等于直接跑查询。 */}
        <button
          type="button"
          onClick={() => onPick(topic.name)}
          className="min-w-0 flex-1 truncate text-left text-[15px] font-medium text-white transition-colors hover:text-blue-400"
        >
          {topic.name || topic.key || "（未命名话题）"}
        </button>
        <span className="shrink-0 font-mono text-[11px] tabular-nums text-blue-500">
          {/* 字段可能缺失：直接插值会印出「undefined 条」。 */}
          {Number.isFinite(topic.articles24h) ? topic.articles24h : 0} 条
        </span>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        <span className="rounded-sm bg-neutral-800 px-1.5 py-0.5 text-[10px] text-neutral-300">
          {TYPE_TEXT[topic.type] ?? topic.type}
        </span>
        {/* 没有基线就没有状态：不写"平稳期"冒充结论。 */}
        {topic.status && (
          <span
            className={
              "rounded-sm px-1.5 py-0.5 text-[10px] " + STATUS_CHIP[topic.status]
            }
            title={topic.statusNote}
          >
            <Term k="heatStatus">{STATUS_TEXT[topic.status]}</Term>
          </span>
        )}
      </div>

      {topic.spark && topic.spark.length >= 3 ? (
        <div className="mt-4">
          <Spark values={topic.spark} />
          <div className="mt-1.5 font-mono text-[9px] text-neutral-700">
            <Term k="baseline">近 {topic.spark.length} 天提及量</Term>
          </div>
        </div>
      ) : null}

      {/* 指标组：浅底、无边框，靠分隔线对齐。 */}
      <div className="mt-4 grid grid-cols-3 divide-x divide-neutral-800/70 rounded-sm bg-neutral-900/50">
        <Cell label={<Term k="heatScore">热度分</Term>} value={
          typeof topic.heatScore === "number" ? topic.heatScore.toFixed(2) : "—"
        } />
        <Cell label={<Term k="heat">热度</Term>} value={topic.heat} accent />
        <Cell label={<Term k="r7">r7</Term>} value={
          typeof topic.r7 === "number" ? topic.r7.toFixed(2) : "—"
        } />
      </div>

      <ul className="mt-4 flex flex-col gap-3">
        {topic.stories.map((s, i) => (
          <li key={s.url + "::" + i} className="flex items-start gap-3">
            <a
              href={s.url}
              target="_blank"
              rel="noreferrer"
              className={
                "line-clamp-2 flex-1 text-sm leading-snug text-neutral-300 transition-colors hover:text-white " +
                (i === 0 ? "" : "text-neutral-400")
              }
              title={s.title + " · " + s.host}
            >
              {s.title}
            </a>
            <span
              className="shrink-0 pt-px font-mono text-[10px] tabular-nums text-neutral-600"
              title={s.points + " 分 · " + s.comments + " 条评论 · " + s.host}
            >
              {s.points}
            </span>
          </li>
        ))}
      </ul>
    </article>
  );
}

/**
 * 热榜是唯一不依赖用户 query 的入口，但它也最容易变成谎言的入口：
 * 单源聚合很容易被读成"全网热点"。所以标题写死"Hacker News 前沿"、
 * 副标题写明样本量与基线天数，降级时把缺了哪个维度说清楚 ——
 * 尤其不能说"GDELT 出口被限流"：代码从未请求过 GDELT，那是在编原因。
 */
export default function TrendingBoard({
  snapshot,
  onPick,
}: {
  snapshot: TrendingSnapshot;
  onPick: (name: string) => void;
}) {
  const { topics, rawStories, consideredStories, windowHours, fetchedAt, degraded, history } = snapshot;
  const missingGdelt = degraded.includes("gdelt:not_configured");
  const noBaseline = history.days === 0 || history.pending;
  const empty = topics.length === 0;
  const legend = STATUS_ORDER.map((s) => ({
    s,
    n: topics.filter((t) => t.status === s).length,
  })).filter((x) => x.n > 0);

  return (
    <section>
      <header className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1.5">
        <div className="flex items-baseline gap-3">
          <h2 className="text-sm font-semibold text-white">Hacker News 前沿</h2>
          <span className="font-mono text-[10px] text-neutral-600">
            <Term k="window">过去 {windowHours}h</Term>
          </span>
          {!empty && (
            <span className="font-mono text-[10px] tabular-nums text-neutral-700">
              {topics.length} 个话题
            </span>
          )}
        </div>
        <span className="font-mono text-[10px] text-neutral-600">
          {consideredStories}/{rawStories} 条进入统计 · 更新于 {fmtTime(fetchedAt)}
          {" · "}
          {noBaseline ? (
            "基线构建中"
          ) : (
            <Term k="baseline">
              基线 {history.days} 天（{fmtDay(history.from)} ~ {fmtDay(history.to)}）
            </Term>
          )}
        </span>
      </header>

      {legend.length > 0 && (
        <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-1.5 border-y border-neutral-800/70 py-2">
          <span className="font-mono text-[9px] uppercase tracking-[0.14em] text-neutral-700">
            状态分布
          </span>
          {legend.map(({ s, n }) => (
            <span key={s} className="flex items-baseline gap-1.5">
              <span className={"rounded-sm px-1.5 py-0.5 text-[10px] " + STATUS_CHIP[s]}>
                {STATUS_TEXT[s]}
              </span>
              <span className="font-mono text-[10px] tabular-nums text-neutral-500">{n}</span>
            </span>
          ))}
        </div>
      )}

      {empty ? (
        <div className="mt-4 rounded-md bg-[#0c0c0c] p-8 text-center text-xs text-neutral-500">
          {rawStories === 0
            ? "Hacker News 本轮没有取到数据，热点榜暂不可用。"
            : "过去 " + windowHours + " 小时里没有话题被两条以上报道同时提到，榜单为空。"}
        </div>
      ) : (
        <div className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {topics.map((t, i) => (
            <TopicCard key={t.key} topic={t} rank={i + 1} onPick={onPick} />
          ))}
        </div>
      )}

      <p className="mt-4 text-[10px] leading-[1.8] text-neutral-600">
        {missingGdelt
          ? "榜单只统计 Hacker News 单源 —— GDELT 新闻索引尚未接入，「多少家媒体在报」这一维度缺位，所以这里给的是技术圈的讨论热度，不是全网热度。"
          : "榜单由 Hacker News 与 GDELT 共同统计。"}
        {noBaseline
          ? " 状态标签要等历史基线建好（约 20 秒）才会出现。"
          : " 状态标签的比较对象是 30 天日序列：r7 = 近 7 日均值 ÷ 前 30 日均值。"}
        {" "}
        点话题名会把该词作为查询跑完整流水线；点标题直接开原文。
      </p>
    </section>
  );
}
