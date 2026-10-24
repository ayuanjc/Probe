"use client";

import type { TrendingSnapshot } from "@/lib/trending";
import type { HeatStatus } from "@/lib/schemas";
import Term from "./Glossary";

const TYPE_TEXT: Record<string, string> = {
  org: "机构",
  tech: "技术",
  event: "事件",
  person: "人物",
  place: "地点",
  product: "产品",
};

/**
 * 状态标签的视觉：只有两种"要你看"的状态用蓝，其余用灰。
 * 爆发期填色（今天确实异常）、升温期描边（正在往上）、平稳/回落描边灰（没有异常）、
 * 长尾用虚线（它讲的是"还在被讨论"，不是"正在爆发"，形状上就该和前面几种区分开）。
 */
const STATUS_TEXT: Record<HeatStatus, string> = {
  burst: "爆发期",
  rising: "升温期",
  stable: "平稳期",
  decaying: "回落期",
  "long-tail": "长尾期",
};

const STATUS_BADGE: Record<HeatStatus, string> = {
  burst: "border-blue-500/60 bg-blue-500/10 text-blue-400",
  rising: "border-blue-500/40 text-blue-400",
  stable: "border-neutral-700 text-neutral-400",
  decaying: "border-neutral-700 text-neutral-500",
  "long-tail": "border-dashed border-neutral-700 text-neutral-400",
};

function fmtTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "未知";
  return d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
}

/** 基线的日期区间只写月-日：年份在"过去 30 天"这个语境里是噪声。 */
function fmtDay(iso: string): string {
  if (!iso) return "—";
  return iso.slice(5).replace("-", "-");
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
  const { topics, fetchedStories, consideredStories, windowHours, fetchedAt, degraded, history } = snapshot;
  const missingGdelt = degraded.includes("gdelt:not_configured");
  const noBaseline = history.days === 0 || history.pending;
  const empty = topics.length === 0;

  return (
    <section>
      <header className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1.5">
        <div className="flex items-baseline gap-3">
          <h2 className="text-sm font-semibold text-white">Hacker News 前沿</h2>
          <span className="font-mono text-[10px] text-neutral-600">
            <Term k="window">过去 {windowHours}h</Term>
          </span>
        </div>
        <span className="font-mono text-[10px] text-neutral-600">
          {consideredStories}/{fetchedStories} 条进入统计 · 更新于 {fmtTime(fetchedAt)}
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

      {empty ? (
        <div className="panel mt-4 p-8 text-center text-xs text-neutral-500">
          {fetchedStories === 0
            ? "Hacker News 本轮没有取到数据，热点榜暂不可用。"
            : "过去 " + windowHours + " 小时里没有话题被两条以上报道同时提到，榜单为空。"}
        </div>
      ) : (
        <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {topics.map((t) => (
            <article key={t.key} className="panel flex flex-col p-5">
              {/* 术语气泡不能塞进按钮里：pointer 事件会被按钮吃掉，点它等于直接跑查询。 */}
              <div className="flex items-start justify-between gap-3">
                <button
                  type="button"
                  onClick={() => onPick(t.name)}
                  className="truncate text-left text-base font-semibold text-white transition-colors hover:text-blue-500"
                >
                  {t.name}
                </button>
                <span className="shrink-0 rounded border border-neutral-700 px-1.5 py-0.5 font-mono text-xs font-medium tabular-nums text-blue-500">
                  {t.articles24h} 条
                </span>
              </div>

              <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
                <span className="rounded border border-neutral-700 px-1.5 py-0.5 text-[10px] text-neutral-400">
                  {TYPE_TEXT[t.type] ?? t.type}
                </span>
                {/* 没有基线就没有状态：不写"平稳期"冒充结论。 */}
                {t.status && (
                  <span
                    className={
                      "rounded border px-1.5 py-0.5 text-[10px] " + STATUS_BADGE[t.status]
                    }
                  >
                    <Term k="heatStatus">{STATUS_TEXT[t.status]}</Term>
                  </span>
                )}
                {typeof t.heatScore === "number" && (
                  <span className="font-mono text-[10px] text-neutral-600">
                    <Term k="heatScore">热度分</Term>{" "}
                    <span className="font-bold tabular-nums text-white">
                      {t.heatScore.toFixed(2)}
                    </span>
                  </span>
                )}
                <span className="font-mono text-[10px] text-neutral-600">
                  <Term k="heat">热度</Term>{" "}
                  <span className="font-bold tabular-nums text-blue-500">{t.heat}</span>
                </span>
                {typeof t.r7 === "number" && (
                  <span className="font-mono text-[10px] text-neutral-600">
                    <Term k="r7">r7</Term>{" "}
                    <span className="tabular-nums text-neutral-300">{t.r7.toFixed(2)}</span>
                  </span>
                )}
              </div>

              {/* 纯文字排列 + 细线分隔：不加左侧装饰，行距换行距。 */}
              <ul className="mt-4 flex flex-col">
                {t.stories.map((s, i) => (
                  <li
                    key={s.url + "::" + i}
                    className="border-b border-neutral-800 py-2.5 last:border-b-0 last:pb-0"
                  >
                    <a
                      href={s.url}
                      target="_blank"
                      rel="noreferrer"
                      className="line-clamp-2 text-[13px] leading-relaxed text-neutral-400 transition-colors hover:text-neutral-200"
                      title={s.title + " · " + s.host}
                    >
                      {s.title}
                    </a>
                  </li>
                ))}
              </ul>
            </article>
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
