import Link from "next/link";
import MetricsPanel from "@/components/MetricsPanel";
import ProbeLogo from "@/components/ProbeLogo";

export const metadata = { title: "运行指标 · 探针" };

export default function MetricsPage() {
  return (
    <main className="mx-auto flex w-full max-w-[1100px] flex-col gap-6 px-5 py-8 sm:px-8">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-neutral-800 pb-5">
        <Link href="/" className="flex items-center" aria-label="回到首页">
          <ProbeLogo size={22} />
        </Link>
        <Link href="/" className="font-mono text-[11px] text-neutral-500 transition-colors hover:text-white">
          ← 返回终端
        </Link>
      </header>

      <div>
        <h1 className="text-lg font-semibold text-white">运行指标</h1>
        <p className="mt-1 max-w-[70ch] text-xs leading-relaxed text-neutral-500">
          PRD 附录 B 里那一行「没有这些指标，调优只能靠猜」。这里记录每一轮的阶段耗时、
          降级码、独立源数与置信度分布 —— 面板上的每个数字都能在这里找到它是怎么来的。
        </p>
      </div>

      <MetricsPanel />
    </main>
  );
}