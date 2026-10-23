"use client";

import type { TrendingSnapshot } from "@/lib/trending";
import Term from "./Glossary";

const TYPE_TEXT: Record<string, string> = {
  org: "机构",
  tech: "技术",
  event: "事件",
  person: "人物",
  place: "地点",
  product: "产品",
};

function fmtTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "未知";
  return d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
}

/**
 * 热榜是唯一不依赖用户 query 的入口，但它也最容易变成谎言的入口：
 * 单源聚合很容易被读成"全网热点"。所以标题写死"Hacker News 前沿"、
 * 副标题写明样本量和时间，降级时把缺了哪个维度说清楚。
 */
export default function TrendingBoard({
  snapshot,
  onPick,
}: {
  snapshot: TrendingSnapshot;
  onPick: (name: string) => void;
}) {
  const { topics, fetchedStories, consideredStories, windowHours, fetchedAt, degraded } = snapshot;
  const missingGdelt = degraded.includes("gdelt");
  const empty = topics.length === 0;

  return (
    <section>
      <header className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1.5 px-1">
        <div className="flex items-baseline gap-3">
          <span className="h-3 w-0.5 shrink-0 self-center bg-cyan-400 shadow-[0_0_8px_rgba(34,211,238,0.9)]" aria-hidden />
          <h2 className="text-sm font-semibold tracking-wide text-white">Hacker News 前沿</h2>
          <span className="font-mono text-[10px] text-neutral-500">
            <Term k="window">过去 {windowHours}h</Term>
          </span>
        </div>
        <span className="font-mono text-[10px] text-neutral-600">
          {consideredStories}/{fetchedStories} 条进入统计 · 更新于 {fmtTime(fetchedAt)}
        </span>
      </header>

      {empty ? (
        <div className="panel mt-4 p-8 text-center text-xs text-neutral-500">
          {fetchedStories === 0
            ? "Hacker News 本轮没有取到数据，热点榜暂不可用。"
            : "过去 " + windowHours + " 小时里没有话题被两条以上报道同时提到，榜单为空。"}
        </div>
      ) : (
        <div className="mt-4 grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {topics.map((t) => (
            <article key={t.key} className="panel flex flex-col p-6">
              {/* 术语气泡不能塞进按钮里：pointer 事件会被按钮吃掉，点它等于直接跑查询。 */}
              <div className="flex items-start justify-between gap-3">
                <button
                  type="button"
                  onClick={() => onPick(t.name)}
                  className="truncate text-left text-lg font-semibold text-white transition-colors hover:text-cyan-300"
                >
                  {t.name}
                </button>
                <span className="shrink-0 rounded border border-cyan-500/25 bg-cyan-500/10 px-2 py-0.5 font-mono text-xs font-bold tabular-nums text-cyan-400">
                  {t.articles24h} 条
                </span>
              </div>
              <div className="mt-3 flex items-baseline gap-2">
                <span className="rounded border border-white/10 bg-white/10 px-2 py-0.5 text-[10px] text-neutral-300">
                  {TYPE_TEXT[t.type] ?? t.type}
                </span>
                <span className="font-mono text-[10px] text-neutral-500">
                  <Term k="heat">热度</Term>{" "}
                  <span className="font-bold tabular-nums text-emerald-400">{t.heat}</span>
                </span>
                <span className="font-mono text-[10px] text-neutral-600">
                  <Term k="articles24h">条数</Term>{" "}
                  <span className="tabular-nums">{t.articles24h}</span>
                </span>
              </div>

              <ul className="mt-4 space-y-3">
                {t.stories.map((s) => (
                  <li key={s.url} className="flex items-start gap-2.5">
                    <span
                      className="mt-[7px] h-1 w-1 shrink-0 rounded-sm bg-cyan-500 shadow-[0_0_6px_rgba(34,211,238,0.85)]"
                      aria-hidden
                    />
                    <a
                      href={s.url}
                      target="_blank"
                      rel="noreferrer"
                      className="line-clamp-2 text-sm leading-relaxed text-neutral-300 transition-colors hover:text-white"
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

      <p className="mt-4 px-1 text-[10px] leading-[1.8] text-neutral-600">
        {missingGdelt
          ? "榜单只统计 Hacker News 单源 —— GDELT 新闻索引当前出口被限流，「多少家媒体在报」这一维度本轮缺位，所以这里给的是技术圈的讨论热度，不是全网热度。"
          : "榜单由 Hacker News 与 GDELT 共同统计。"}
        {" "}
        点话题名会把该词作为查询跑完整流水线；点标题直接开原文。
      </p>
    </section>
  );
}
