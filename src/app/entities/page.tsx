import type { Metadata } from "next";
import Link from "next/link";
import { entityEnabled, entityStats, topEntities } from "@/lib/entity-track";
import { KIND_TEXT } from "@/lib/watch-match";

/**
 * 实体追踪索引 /entities：最近 7 天被热榜提到最多的实体。
 *
 * 公开页。它存在的意义有两层：给 /e/<实体> 一个入口（爬虫与人都需要），
 * 也让人一眼看到「这台机器这两天在盯谁」—— 这本身就是产品的一部分。
 */
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "实体追踪",
  description: "最近 7 天被热榜提到最多的公司、技术与事件，按来源可信度分档、按时间线分叉。",
};

function fmtAt(at: number | null): string {
  if (!at) return "—";
  return new Date(at).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Asia/Shanghai",
  });
}

export default function EntitiesPage() {
  const enabled = entityEnabled();
  const stats = enabled ? entityStats() : { hits: 0, entities: 0, oldestAt: null };
  const top = enabled ? topEntities({ days: 7, limit: 30 }) : [];

  return (
    <main className="mx-auto w-full max-w-[880px] px-5 py-10">
      <nav className="mb-6 font-mono text-[11px] text-neutral-600">
        <Link href="/login" className="transition-colors hover:text-neutral-300">
          探针
        </Link>
        <span className="mx-2 text-neutral-800">/</span>
        <span className="text-neutral-500">实体追踪</span>
      </nav>

      <header className="mb-6">
        <h1 className="text-[26px] font-semibold tracking-tight text-white">实体追踪</h1>
        <p className="mt-2 max-w-[640px] text-[13px] leading-relaxed text-neutral-400">
          热榜里提到过的公司、技术与事件，按「谁先说、谁更接近源头、各家说法是否一致」排成时间线。
          点进任意一个实体就能看到它最近的分支。
        </p>
        <div className="mt-3 flex flex-wrap gap-x-6 gap-y-1 font-mono text-[11px] text-neutral-500">
          <span>
            库里 <span className="text-neutral-200">{stats.hits}</span> 条命中
          </span>
          <span>
            覆盖 <span className="text-neutral-200">{stats.entities}</span> 个实体
          </span>
          {stats.oldestAt && <span>最早 {fmtAt(stats.oldestAt)}</span>}
        </div>
      </header>

      {!enabled ? (
        <p className="rounded border border-neutral-800 bg-black px-3 py-6 text-center font-mono text-[11px] text-neutral-600">
          实体追踪已在服务端关闭（PROBE_ENTITY_SERVER=0）。
        </p>
      ) : top.length === 0 ? (
        <div className="rounded border border-neutral-800 bg-black px-4 py-8 text-center">
          <p className="text-[13px] text-neutral-300">还没有命中。</p>
          <p className="mt-2 font-mono text-[10px] leading-relaxed text-neutral-600">
            热榜每 5 分钟算一轮，第一轮命中入库后这里就会有内容。
          </p>
        </div>
      ) : (
        <ul className="flex flex-col divide-y divide-neutral-900 rounded border border-neutral-800">
          {top.map((e, i) => (
            <li key={e.key}>
              <Link
                href={"/e/" + encodeURIComponent(e.key)}
                className="flex items-center gap-3 px-3 py-2.5 transition-colors hover:bg-neutral-950"
              >
                <span className="w-6 shrink-0 text-right font-mono text-[10px] text-neutral-700">{i + 1}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] text-neutral-200">{e.name}</span>
                  <span className="mt-0.5 block font-mono text-[10px] text-neutral-600">
                    {KIND_TEXT[e.kind] ?? "其他"} · 最近 {fmtAt(e.lastAt)}
                  </span>
                </span>
                <span className="shrink-0 text-right font-mono text-[10px] text-neutral-500">
                  <span className="block text-[13px] text-neutral-200">{e.total}</span>
                  7 天
                </span>
                <span className="w-12 shrink-0 text-right font-mono text-[10px] text-neutral-500">
                  <span className="block text-[13px] text-neutral-200">{e.last24h}</span>
                  24h
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}

      <section className="mt-8 border-t border-neutral-900 pt-4">
        <h2 className="font-mono text-[10px] uppercase tracking-wider text-neutral-600">口径</h2>
        <ul className="mt-2 flex flex-col gap-1.5 text-[12px] leading-relaxed text-neutral-500">
          <li>只记词典里的实体（技术词典，不是 NER），标题命中才算 —— 宁可少记，不乱记。</li>
          <li>只存标题、链接、来源、时间，不存正文；没有用户字段，也无法反推谁看过。</li>
          <li>命中保留 30 天，每个实体最多 200 条，超出丢最旧的。</li>
          <li>
            同一条消息的多家报道会被聚成一个事件并分叉，档位是来源类型，不是真伪判定。
          </li>
        </ul>
      </section>
    </main>
  );
}
