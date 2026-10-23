"use client";

import type { TrendingSnapshot } from "@/lib/trending";

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
    <section className="mt-2">
      <header className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <div className="flex items-baseline gap-2">
          <h2 className="text-[12px] tracking-[0.08em] text-[#cbd5e1]">Hacker News 前沿</h2>
          <span className="text-[10px] text-[#3f4854]">过去 {windowHours} 小时</span>
        </div>
        <span className="text-[10px] text-[#3f4854]">
          {consideredStories}/{fetchedStories} 条进入统计 · 更新于 {fmtTime(fetchedAt)}
        </span>
      </header>

      {empty ? (
        <div className="panel mt-2 px-4 py-8 text-center text-[11px] text-[#5c6675]">
          {fetchedStories === 0
            ? "Hacker News 本轮没有取到数据，热点榜暂不可用。"
            : "过去 " + windowHours + " 小时里没有话题被两条以上报道同时提到，榜单为空。"}
        </div>
      ) : (
        <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {topics.map((t) => (
            <article
              key={t.key}
              className="panel flex flex-col px-3 py-2.5 transition hover:border-[#5eead4]/28"
            >
              <button type="button" onClick={() => onPick(t.name)} className="w-full text-left">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="truncate text-[13px] text-[#e2e8f0]">{t.name}</span>
                  <span className="shrink-0 text-[10px] text-[#5eead4]">{t.articles24h} 条</span>
                </div>
                <div className="mt-1 flex items-baseline justify-between gap-2 text-[10px] text-[#3f4854]">
                  <span>{TYPE_TEXT[t.type] ?? t.type}</span>
                  <span className="font-mono">热度 {t.heat}</span>
                </div>
              </button>

              <ul className="mt-2 space-y-1 border-t border-white/5 pt-2">
                {t.stories.map((s) => (
                  <li key={s.url} className="truncate text-[10px] leading-[1.5]">
                    <a
                      href={s.url}
                      target="_blank"
                      rel="noreferrer"
                      className="text-[#7b8798] transition hover:text-[#b9c4d2]"
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

      <p className="mt-2 text-[10px] leading-[1.7] text-[#3f4854]">
        {missingGdelt
          ? "榜单只统计 Hacker News 单源 —— GDELT 新闻索引当前出口被限流，「多少家媒体在报」这一维度本轮缺位，所以这里给的是技术圈的讨论热度，不是全网热度。"
          : "榜单由 Hacker News 与 GDELT 共同统计。"}
        {" "}
        点话题名会把该词作为查询跑完整流水线；点标题直接开原文。
      </p>
    </section>
  );
}
