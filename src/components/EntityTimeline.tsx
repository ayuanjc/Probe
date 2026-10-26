import type { TimelineEvent } from "@/lib/entity-timeline";
import { providerLabel } from "@/lib/provider-label";

/**
 * 事件时间线：主干 + 分支。
 *
 * 这里刻意不做「一条一票」的平铺列表 —— 同一件事被五家写在五个标题里，
 * 平铺等于让读者自己数重复。分叉要表达的只有三件事：
 *   1. 谁先说的（时间轴从左到右，主干那条的时间就是事件时间）；
 *   2. 谁更接近源头（档位徽章：官方/一手 > 主流 > 行业 > 聚合）；
 *   3. 说法一致不一致（相似度低的挂「说法不一致」黄标）。
 *
 * 不写「可信 / 不可信」：那是对内容下结论，我们只摆来源与分歧。
 */

const TIER_STYLE: Record<number, { chip: string; dot: string; text: string }> = {
  1: { chip: "border-blue-500/50 bg-blue-500/10 text-blue-300", dot: "bg-blue-400", text: "text-blue-300" },
  2: { chip: "border-emerald-500/40 bg-emerald-500/10 text-emerald-300", dot: "bg-emerald-400", text: "text-emerald-300" },
  3: { chip: "border-neutral-700 bg-neutral-900 text-neutral-300", dot: "bg-neutral-500", text: "text-neutral-300" },
  4: { chip: "border-neutral-800 bg-neutral-900/60 text-neutral-500", dot: "bg-neutral-600", text: "text-neutral-500" },
};

function styleOf(tier: number) {
  return TIER_STYLE[tier] ?? TIER_STYLE[4];
}

/** 时间统一按 +08:00 渲染：服务端在 UTC，浏览器在本地，不写死会出现两个字符串。 */
export function fmtAt(at: number): string {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return "未知时间";
  return d.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Asia/Shanghai",
  });
}

function sourceLine(host: string | null, provider: string | null): string {
  const bits: string[] = [];
  if (host) bits.push(host);
  else if (provider) bits.push(providerLabel(provider));
  else bits.push("来源未记");
  if (host && provider) bits.push(providerLabel(provider));
  return bits.join(" · ");
}

function BranchRow({ event, branch }: { event: TimelineEvent; branch: TimelineEvent["branches"][number] }) {
  const s = styleOf(branch.tier);
  const gap = Math.abs(branch.tier - event.main.tier);
  return (
    <li className="relative pl-5">
      <span className={"absolute left-0 top-[7px] h-1.5 w-1.5 rounded-full " + s.dot} aria-hidden />
      <a
        href={branch.url}
        target="_blank"
        rel="noreferrer noopener"
        className="text-[12px] leading-snug text-neutral-400 transition-colors hover:text-white"
      >
        {branch.title}
      </a>
      <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[10px] text-neutral-600">
        <span className={"rounded border px-1 py-[1px] " + s.chip}>{branch.tierLabel}</span>
        <span>{sourceLine(branch.host, branch.provider)}</span>
        <span>{fmtAt(branch.at)}</span>
        {branch.similarity < 0.55 && (
          <span className="text-amber-500" title="与主干的标题相似度低，可能是另一个说法">
            说法不一致
          </span>
        )}
        {gap >= 2 && (
          <span className="text-amber-600/80" title="与主干相差两档以上，尚未被更高档的源确认">
            档位差 {gap}
          </span>
        )}
      </div>
    </li>
  );
}

export default function EntityTimeline({ events }: { events: TimelineEvent[] }) {
  if (events.length === 0) {
    return (
      <p className="rounded border border-neutral-800 bg-black px-3 py-6 text-center font-mono text-[11px] text-neutral-600">
        还没有命中。热榜每 5 分钟算一轮，命中要等下一轮。
      </p>
    );
  }
  return (
    <ol className="flex flex-col gap-4">
      {events.map((e) => {
        const s = styleOf(e.main.tier);
        const wide = e.tiers.length >= 2;
        return (
          <li key={e.id} className="rounded border border-neutral-800 bg-black">
            <div className="flex flex-col gap-1 px-3 py-2.5">
              <div className="flex items-start gap-2">
                <span className={"mt-[1px] shrink-0 rounded border px-1 py-[1px] font-mono text-[10px] " + s.chip}>
                  {e.main.tierLabel}
                </span>
                <a
                  href={e.main.url}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="text-[13px] leading-snug text-neutral-100 transition-colors hover:text-white"
                >
                  {e.main.title}
                </a>
              </div>
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[10px] text-neutral-600">
                <span>{sourceLine(e.main.host, e.main.provider)}</span>
                <span>{fmtAt(e.main.at)}</span>
                {e.branches.length > 0 && <span className="text-neutral-500">{e.branches.length + 1} 个来源</span>}
                {e.spanHours > 0 && <span>跨度 {e.spanHours}h</span>}
                {wide && <span className={e.divergent ? "text-amber-500" : "text-neutral-500"}>
                  {e.divergent ? "多档来源 · 说法不一" : "多档来源"}
                </span>}
              </div>
            </div>
            {e.branches.length > 0 && (
              <ul className="flex flex-col gap-2 border-t border-neutral-900 px-3 py-2">
                {e.branches.map((b) => (
                  <BranchRow key={b.id} event={e} branch={b} />
                ))}
              </ul>
            )}
          </li>
        );
      })}
    </ol>
  );
}
