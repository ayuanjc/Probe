"use client";

import type { CnSnapshot, CnTopic } from "@/lib/cn-trending";
import { HEAT_STATUS_CHIP, HEAT_STATUS_TEXT } from "@/lib/heat-labels";
import Term from "./Glossary";

/**
 * 中文科技前沿：与「Hacker News 前沿」同一个公式，但不同源、不同基线。
 *
 * 这块最需要克制的两件事：
 *  1. 不要写成「全网热点」。它就是 IT之家 与 少数派 在写什么，两家编辑室的口味。
 *  2. 不要在前 14 天里编状态。基线是从挂上那天开始攒的（两个源没有历史检索接口），
 *     攒够之前只给名次，并明确写出「攒到第几天」—— 空白比假标签诚实，
 *     但也得让读者知道为什么这里是空的。
 */

const TYPE_TEXT: Record<string, string> = {
  org: "机构",
  tech: "技术",
  event: "事件",
  person: "人物",
  place: "地点",
  product: "产品",
};

const DEGRADED_TEXT: Record<string, string> = {
  "ithome:list_failed": "IT之家接口：本轮没取到",
  "ithome:rss_failed": "IT之家 RSS：本轮没取到（覆盖窗口会缩短）",
  "sspai:failed": "少数派：本轮没取到",
  "cn:empty": "两家都没取到内容",
  "cn:baseline_empty": "中文源基线还没开始攒（第一轮 cron 之后才有）",
};

function fmtTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "未知";
  return d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Shanghai" });
}

/** 火花线：与 HN 那块同款内联 SVG，14 个点画一条折线，不引图表库。 */
function Spark({ values }: { values: number[] }) {
  if (values.length < 3) return null;
  const W = 100;
  const H = 22;
  const max = Math.max(1, ...values);
  const step = W / (values.length - 1);
  const points = values.map((v, i) => [i * step, H - (v / max) * (H - 2) - 1] as const);
  const d = points.map(([x, y], i) => (i === 0 ? "M" : "L") + x.toFixed(1) + " " + y.toFixed(1)).join(" ");
  return (
    <svg viewBox={"0 0 " + W + " " + H} className="h-5 w-20 shrink-0" preserveAspectRatio="none" aria-hidden>
      <path d={d} fill="none" stroke="currentColor" strokeWidth={1} vectorEffect="non-scaling-stroke" className="text-neutral-600" />
    </svg>
  );
}

function Row({ topic, rank }: { topic: CnTopic; rank: number }) {
  return (
    <li className="border-t border-neutral-800/60 py-3 first:border-t-0 first:pt-0">
      <div className="flex items-baseline gap-2.5">
        <span className="w-5 shrink-0 text-right font-mono text-[10px] tabular-nums text-neutral-700">{rank}</span>
        <span className="text-[13px] font-medium text-white">{topic.name}</span>
        <span className="rounded-sm bg-neutral-800 px-1 text-[9px] text-neutral-500">
          {TYPE_TEXT[topic.type] ?? topic.type}
        </span>
        {topic.status ? (
          <span
            className={"rounded-sm px-1.5 py-0.5 text-[10px] " + HEAT_STATUS_CHIP[topic.status]}
            title={topic.statusNote}
          >
            {HEAT_STATUS_TEXT[topic.status]}
          </span>
        ) : null}
        <span className="ml-auto shrink-0 font-mono text-[10px] tabular-nums text-neutral-500">
          {topic.articles24h} 篇
        </span>
        {topic.spark ? <Spark values={topic.spark} /> : null}
      </div>

      <div className="mt-1.5 flex flex-col gap-1 pl-[30px]">
        {topic.stories.map((s) => (
          <a
            key={s.url}
            href={s.url}
            target="_blank"
            rel="noreferrer noopener"
            className="line-clamp-1 text-[11px] leading-snug text-neutral-500 transition-colors hover:text-neutral-300"
            title={s.url}
          >
            {s.title}
          </a>
        ))}
        {topic.r7 !== undefined ? (
          <span className="font-mono text-[10px] text-neutral-700">
            <Term k="r7">r7</Term> {topic.r7.toFixed(2)}
          </span>
        ) : null}
      </div>
    </li>
  );
}

export default function CnTrendingBoard({ snapshot }: { snapshot: CnSnapshot }) {
  const { topics, sources, history, degraded, fetchedAt, consideredStories } = snapshot;
  const notes = degraded
    .filter((d) => d !== "cn:baseline_partial" && d !== "cn:baseline_empty")
    .map((d) => DEGRADED_TEXT[d] ?? d)
    .filter(Boolean);

  const sourceText = sources
    .map((s) => s.name + (s.ok ? " 覆盖约 " + Math.round(s.coveredHours) + " 小时 · " + s.count + " 条" : " 未取到"))
    .join("；");

  return (
    <section>
      <header className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1.5">
        <div className="flex flex-wrap items-baseline gap-3">
          <h2 className="text-sm font-semibold text-white">中文科技前沿</h2>
          <span className="font-mono text-[10px] text-neutral-600">
            IT之家 · 少数派 {consideredStories} 条进入统计
          </span>
        </div>
        <span className="font-mono text-[10px] text-neutral-600">抓取于 {fmtTime(fetchedAt)}</span>
      </header>

      {history.pending ? (
        <p className="mt-3 rounded-md bg-[#0c0c0c] px-3 py-2 text-[10px] leading-[1.8] text-neutral-500">
          中文源基线攒到 <span className="font-mono text-neutral-400">{history.days}/{history.needed}</span> 天
          （这两个源没有历史检索接口，只能从挂上那天开始记）。攒够之前只排名次、不给状态标签 ——
          缺失比一个猜出来的「升温期」诚实。HN 那块不受影响，它的 30 天基线是独立的。
        </p>
      ) : null}

      {topics.length === 0 ? (
        <div className="mt-4 rounded-md bg-[#0c0c0c] p-6 text-center text-xs text-neutral-500">
          这一轮没取到中文科技资讯。
          {notes.length > 0 ? " （" + notes.join("；") + "）" : ""}
        </div>
      ) : (
        <ul className="mt-4 flex flex-col">
          {topics.map((t, i) => (
            <Row key={t.key} topic={t} rank={i + 1} />
          ))}
        </ul>
      )}

      {topics.length > 0 && notes.length > 0 ? (
        <p className="mt-3 text-[10px] leading-[1.7] text-neutral-600">{notes.join("；")}</p>
      ) : null}

      <p className="mt-3 text-[10px] leading-[1.8] text-neutral-600">
        {sourceText}。窗口按 24 小时算，但两源都只提供「最近若干条」，所以真实覆盖不到 24 小时 ——
        这个数字写在上面，不假装是全天。名次 = 24 小时里有多少篇在写它（不是投票，是编辑的选题），
        所以「1 篇」也会上榜；能说明「这是不是异常」的只有状态标签，而它要等基线。
      </p>
    </section>
  );
}
