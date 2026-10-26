"use client";

import type { HotEntry, HotList, HotListsSnapshot } from "@/lib/hotlist";
import { formatCount } from "@/lib/hotlist";

/**
 * 国内热议：榜单轨的界面。
 *
 * 这里最容易犯的错是把「百度热搜」和上面的「Hacker News 前沿」画成同一个东西 ——
 * 上面的名次来自 24 小时文章量与 30 天基线，这里的名次来自百度自己给的顺序，
 * 两个数字不可比。所以两块刻意长得不一样：这里没有热度分、没有状态标签、
 * 没有火花线，只有一个「上游给的数值」和一个「什么变了」的小角标。
 */

const CHANGE_TEXT: Record<string, string> = { new: "新", up: "升", same: "" };

const SOURCE_WHY: Record<string, string> = {
  baidu: "点标题开的是百度搜索该词的结果页，不是我们抓的原文。",
  juejin: "点标题直接开掘金原文。",
};

const DEGRADED_TEXT: Record<string, string> = {
  "baidu:failed": "百度热搜：本轮没取到（上游超时或被限流）",
  "baidu:empty": "百度热搜：上游返回了空榜单",
  "juejin:failed": "掘金热榜：本轮没取到",
  "juejin:empty": "掘金热榜：上游返回空",
  "hotlist:disabled": "国内热议已在服务端关闭（PROBE_HOTLIST_SERVER=0）",
  "hotlist:empty": "国内榜单这一轮全部没取到",
};

function fmtTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "未知";
  // 时区写死：服务端渲染在 UTC，浏览器在 +08:00，不指定就会出现两个不同的字符串。
  return d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Shanghai" });
}

function Row({ entry }: { entry: HotEntry }) {
  const change = entry.change ? CHANGE_TEXT[entry.change] : "";
  return (
    <li className="flex items-baseline gap-2.5">
      <span className="w-5 shrink-0 text-right font-mono text-[10px] tabular-nums text-neutral-700">
        {entry.rank}
      </span>
      <a
        href={entry.url}
        target="_blank"
        rel="noreferrer noopener"
        className="line-clamp-1 flex-1 text-[13px] leading-snug text-neutral-300 transition-colors hover:text-white"
        title={(entry.summary ? entry.summary + "\n\n" : "") + entry.url}
      >
        {entry.title}
      </a>
      {change ? (
        <span className="shrink-0 rounded-sm bg-blue-500/10 px-1 text-[9px] text-blue-400">{change}</span>
      ) : null}
      <span className="w-14 shrink-0 text-right font-mono text-[10px] tabular-nums text-neutral-600">
        {entry.score === null ? "—" : formatCount(entry.score)}
      </span>
    </li>
  );
}

function Card({ list }: { list: HotList }) {
  const head = list.entries.slice(0, 12);
  const rest = list.entries.slice(12);
  return (
    <article className="rounded-md bg-[#0c0c0c] p-4">
      <header className="flex items-baseline justify-between gap-3">
        <h3 className="text-[13px] font-semibold text-white">{list.label}</h3>
        <span className="font-mono text-[10px] tabular-nums text-neutral-600">
          {list.entries.length} 条 · 抓取于 {fmtTime(list.fetchedAt)}
        </span>
      </header>

      <ul className="mt-3 flex flex-col gap-2">
        {head.map((e) => (
          <Row key={e.url} entry={e} />
        ))}
      </ul>

      {rest.length > 0 && (
        <details className="mt-2">
          <summary className="cursor-pointer list-none font-mono text-[10px] text-neutral-600 hover:text-neutral-400">
            + 展开其余 {rest.length} 条
          </summary>
          <ul className="mt-2 flex flex-col gap-2">
            {rest.map((e) => (
              <Row key={e.url} entry={e} />
            ))}
          </ul>
        </details>
      )}

      <p className="mt-3 border-t border-neutral-800/70 pt-2 text-[10px] leading-[1.7] text-neutral-600">
        {list.note} {SOURCE_WHY[list.provider] ?? ""}
      </p>
    </article>
  );
}

export default function HotListBoard({ snapshot }: { snapshot: HotListsSnapshot }) {
  const { lists, degraded, fetchedAt } = snapshot;
  const notes = degraded
    .filter((d) => d !== "hotlist:empty")
    .map((d) => DEGRADED_TEXT[d] ?? d)
    .filter(Boolean);

  return (
    <section>
      <header className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1.5">
        <div className="flex items-baseline gap-3">
          <h2 className="text-sm font-semibold text-white">国内热议</h2>
          <span className="font-mono text-[10px] text-neutral-600">榜单原样 · 不参与热度公式</span>
        </div>
        <span className="font-mono text-[10px] text-neutral-600">更新于 {fmtTime(fetchedAt)}</span>
      </header>

      {lists.length === 0 ? (
        <div className="mt-4 rounded-md bg-[#0c0c0c] p-6 text-center text-xs text-neutral-500">
          国内榜单这一轮没取到。
          {notes.length > 0 ? " （" + notes.join("；") + "）" : ""}
        </div>
      ) : (
        <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
          {lists.map((l) => (
            <Card key={l.provider} list={l} />
          ))}
        </div>
      )}

      {lists.length > 0 && notes.length > 0 ? (
        <p className="mt-3 text-[10px] leading-[1.7] text-neutral-600">{notes.join("；")}</p>
      ) : null}

      <p className="mt-3 text-[10px] leading-[1.8] text-neutral-600">
        这一块是「别人此刻在加热什么」：条目与数值都来自上游榜单，我们只做搬运与标注，
        不重排、不算分、不给状态标签 —— 上面的「Hacker News 前沿」才有 30 天基线那套算法。
        微博（403）与知乎（401）需要登录态，没有接入；不在这块里假装有。
      </p>
    </section>
  );
}
