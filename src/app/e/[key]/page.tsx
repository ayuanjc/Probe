import type { Metadata } from "next";
import Link from "next/link";
import EntityTimeline from "@/components/EntityTimeline";
import { buildTimeline } from "@/lib/entity-timeline";
import { dictEntities, entityEnabled, entitySummary, listEntityHits } from "@/lib/entity-track";
import { providerLabel } from "@/lib/provider-label";
import { KIND_TEXT } from "@/lib/watch-match";

/**
 * 公开实体时间线 /e/<实体>。
 *
 * 为什么不用登录：这一页回答的是「这家公司最近被谁怎么说」—— 恰恰是陌生人
 * 第一次接触这个站时最想验证的问题。把它放在登录墙后面，等于要求人先相信我们，
 * 才能看我们凭什么值得相信。
 *
 * 页面只读本地 SQLite 的 entity_hits（标题 / 链接 / 来源 / 档位 / 时间），
 * 不触发任何上游调用，所以被爬也不会烧钱。
 */
export const dynamic = "force-dynamic";

type PageProps = { params: Promise<{ key: string }> };

function decodeKey(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const key = decodeKey((await params).key);
  return {
    title: key + " · 实体时间线",
    description: key + " 在热榜里最近被哪些来源提到：按来源可信度分档，同一条消息的多家说法并排显示。",
    // 没有命中的实体页不索引：一个空页面被搜索引擎收进去，比 404 更难看。
    robots: entityEnabled() ? undefined : { index: false, follow: false },
  };
}

function fmtDay(at: number): string {
  return new Date(at).toLocaleDateString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", timeZone: "Asia/Shanghai" });
}

export default async function EntityPage({ params }: PageProps) {
  const raw = decodeKey((await params).key);
  const enabled = entityEnabled();
  const summary = enabled ? entitySummary(raw) : null;
  const hits = enabled && summary && summary.total > 0 ? listEntityHits(summary.key, { limit: 120 }).items : [];
  const events = buildTimeline(hits);
  const dict = dictEntities().find((e) => e.key === String(raw).trim().toLowerCase());
  const name = summary?.name || dict?.name || raw;
  const kind = summary?.kind ?? dict?.kind ?? "other";

  return (
    <main className="mx-auto w-full max-w-[880px] px-5 py-10">
      <nav className="mb-6 flex items-center gap-3 font-mono text-[11px] text-neutral-600">
        <Link href="/entities" className="transition-colors hover:text-neutral-300">
          ← 实体追踪
        </Link>
        <span className="text-neutral-800">/</span>
        <span className="truncate text-neutral-500">{name}</span>
      </nav>

      <header className="mb-6">
        <div className="flex flex-wrap items-baseline gap-3">
          <h1 className="text-[26px] font-semibold tracking-tight text-white">{name}</h1>
          <span className="rounded border border-neutral-800 px-1.5 py-[1px] font-mono text-[10px] text-neutral-400">
            {KIND_TEXT[kind] ?? "其他"}
          </span>
          <span className="font-mono text-[10px] text-neutral-600">公开 · 不需要登录</span>
        </div>
        {summary && summary.total > 0 ? (
          <>
            <div className="mt-3 flex flex-wrap gap-x-6 gap-y-1 font-mono text-[11px] text-neutral-500">
              <span>
                共 <span className="text-neutral-200">{summary.total}</span> 条
              </span>
              <span>
                24 小时 <span className="text-neutral-200">{summary.last24h}</span>
              </span>
              <span>
                7 天 <span className="text-neutral-200">{summary.last7d}</span>
              </span>
              <span>
                来源 <span className="text-neutral-200">{summary.sources.length}</span>
              </span>
              {summary.firstAt && <span>最早 {fmtDay(summary.firstAt)}</span>}
              {summary.lastAt && <span>最近 {fmtDay(summary.lastAt)}</span>}
            </div>
            {summary.sources.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {summary.sources.map((s) => (
                  <span
                    key={s.provider}
                    className="rounded border border-neutral-800 px-1.5 py-[1px] font-mono text-[10px] text-neutral-500"
                  >
                    {providerLabel(s.provider)} {s.n}
                  </span>
                ))}
              </div>
            )}
          </>
        ) : null}
      </header>

      {!enabled ? (
        <p className="rounded border border-neutral-800 bg-black px-3 py-6 text-center font-mono text-[11px] text-neutral-600">
          实体追踪已在服务端关闭（PROBE_ENTITY_SERVER=0）。
        </p>
      ) : events.length === 0 ? (
        <div className="rounded border border-neutral-800 bg-black px-4 py-8 text-center">
          <p className="text-[13px] text-neutral-300">最近还没有来源提到「{name}」。</p>
          <p className="mt-2 font-mono text-[10px] leading-relaxed text-neutral-600">
            时间线只覆盖热榜抓到的条目（HN / IT之家 / 少数派 / 百度热搜 / 掘金），
            不是全网检索。热榜每 5 分钟算一轮，命中要等下一轮。
          </p>
        </div>
      ) : (
        <EntityTimeline events={events} />
      )}

      <section className="mt-8 flex flex-col gap-2 rounded border border-neutral-800 px-3 py-3">
        <p className="text-[12px] text-neutral-400">
          想让它一出现就记一条？登录后可以在搜索结果的实体标签上点「关注」，
          命中只在你自己的账号里，不发邮件、不推手机。
        </p>
        <div className="flex flex-wrap gap-3 font-mono text-[11px]">
          <Link href="/login" className="text-blue-400 transition-colors hover:text-blue-300">
            登录 / 关注 →
          </Link>
          <Link href="/entities" className="text-neutral-500 transition-colors hover:text-neutral-300">
            看看今天谁被提到最多
          </Link>
        </div>
      </section>

      <section className="mt-6 border-t border-neutral-900 pt-4">
        <h2 className="font-mono text-[10px] uppercase tracking-wider text-neutral-600">这一页怎么读</h2>
        <ul className="mt-2 flex flex-col gap-1.5 text-[12px] leading-relaxed text-neutral-500">
          <li>
            <span className="text-neutral-300">主干</span>：同一件事里可信度档位最高的一条；
            同一档取更早的 —— 先说的人更接近源头。
          </li>
          <li>
            <span className="text-neutral-300">分支</span>：其它来源的说法，按档位排列，标出与主干的相似度问题。
            「说法不一致」只表示标题差异大，不代表谁错。
          </li>
          <li>
            <span className="text-neutral-300">档位</span>：官方 / 一手 → 主流媒体 → 行业媒体 → 聚合 / 社区。
            这是<span className="text-neutral-300">来源类型</span>，不是真伪判定；我们不替你下结论。
          </li>
          <li>
            <span className="text-neutral-300">时间</span>：取上游给的发布时间，不是我们抓到的时刻。
            上游不给（掘金热榜、百度热搜榜单）就退回抓取时间 —— 这两种在页面上看起来一样，
            因为「几点被写出来」和「几点被我们看见」在热榜这种流里只差几分钟。
          </li>
          <li>
            聚类按标题 token 相似度 + 48 小时时间窗，纯本地计算。所以它会把两条措辞差异很大的报道
            当成两件事，也可能把同一天的两件事并成一条 —— 点开原文永远是最可靠的读法。
          </li>
        </ul>
      </section>
    </main>
  );
}
