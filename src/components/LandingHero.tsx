"use client";

import ProbeLogo from "./ProbeLogo";
import SearchBar from "./SearchBar";

/**
 * 首页 = 一张「搜索入口」的封面。
 *
 * 为什么把热榜挪到下一屏：一屏里同时放热榜和检索入口，用户会先读榜、再决定问什么，
 * 产品从「你说问题我给证据」退化成「看我们今天抓到了什么」。
 * 所以首页只留锁标 + 输入行，热榜降成下一层（同一页面向下滚，不另开路由），
 * 想先看看再问的人一根手指就能到。
 */
export default function LandingHero({
  running,
  value,
  onChange,
  onRun,
  hasTrending,
}: {
  running: boolean;
  value: string;
  onChange: (value: string) => void;
  onRun: (query: string) => void;
  hasTrending: boolean;
}) {
  const jump = () => {
    document.getElementById("trending")?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    <section className="flex min-h-[calc(100svh-5.5rem)] flex-col items-center justify-center gap-9 pb-16 pt-6">
      <h1 className="flex justify-center">
        <ProbeLogo orientation="vertical" size="clamp(40px,6vw,80px)" subtitle={null} />
      </h1>

      <p className="font-mono text-[11px] tracking-[0.18em] text-neutral-600">
        无源不显示 · 缺失不填 0
      </p>

      <div className="w-full max-w-[720px]">
        <SearchBar
          size="lg"
          running={running}
          value={value}
          onChange={onChange}
          onRun={onRun}
        />
      </div>

      {hasTrending && (
        <button
          type="button"
          onClick={jump}
          className="group flex flex-col items-center gap-1 font-mono text-[10px] text-neutral-600 transition-colors hover:text-neutral-400"
        >
          <span>不看提问，先看今天的 24 小时热点</span>
          <span aria-hidden className="text-sm leading-none transition-transform group-hover:translate-y-0.5">
            ↓
          </span>
        </button>
      )}
    </section>
  );
}