import { CALIBRATION_LABEL, type CalibrationVerdict } from "@/lib/calibration";
import type { CalibrationSnapshot } from "@/lib/calibration-store";

/**
 * 校准面板：把「吻合度 79% 到底可不可信」量出来。
 *
 * 三件事必须一起显示，缺一个就会骗人：
 *   1. 三个误差数（ECE / MCE / Brier）—— 单看 ECE 会漏掉「只在一个箱里错得离谱」；
 *   2. 样本量 n —— 20 条的 ECE 精度约等于噪声，所以 n < 50 一律写「样本不足」；
 *   3. 分箱表 —— 让「报 0.9 的那批实际对了几成」能一行一行看，而不是只信一个总分。
 */

const VERDICT_STYLE: Record<CalibrationVerdict, string> = {
  ok: "border-emerald-500/30 bg-emerald-500/10 text-emerald-500",
  warn: "border-amber-500/30 bg-amber-500/10 text-amber-500",
  bad: "border-red-500/30 bg-red-500/10 text-red-500",
  unknown: "border-neutral-700 bg-neutral-800/40 text-neutral-400",
};

function pct(x: number, digits = 0): string {
  return (x * 100).toFixed(digits) + "%";
}

function binLabel(low: number, high: number): string {
  const fmt = (x: number) => x.toFixed(1);
  return fmt(low) + "–" + fmt(high);
}

export default function CalibrationCard({ snapshot }: { snapshot: CalibrationSnapshot }) {
  const { counts, report, verdict, budget } = snapshot;

  return (
    <section className="panel rounded-md p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-mono text-[11px] uppercase tracking-wide text-neutral-400">校准</h2>
        <span
          className={"rounded border px-2 py-0.5 font-mono text-[11px] " + VERDICT_STYLE[verdict]}
        >
          {CALIBRATION_LABEL[verdict]}
        </span>
      </div>

      <p className="mt-2 max-w-[72ch] text-xs leading-relaxed text-neutral-500">
        吻合度是一个预测：它说「八成能立住」。校准量的是这句话本身准不准 ——
        报 {pct(0.9)} 的那批断言，实际是不是真有那么高的比例成立。
        它不影响任何单条结论，只回答「这个分数能不能当真」。
      </p>

      <dl className="mt-3 grid grid-cols-2 gap-2 font-mono text-[11px] sm:grid-cols-4">
        <div className="rounded border border-neutral-800 bg-[#0f0f0f] p-2">
          <dt className="text-neutral-500">样本（已标注 / 总）</dt>
          <dd className="mt-0.5 text-neutral-200">
            {counts.labeled} / {counts.total}
          </dd>
        </div>
        <div className="rounded border border-neutral-800 bg-[#0f0f0f] p-2">
          <dt className="text-neutral-500">ECE</dt>
          <dd className="mt-0.5 text-neutral-200">
            {report ? pct(report.ece, 1) : "—"}
            <span className="ml-1 text-neutral-600">/ 预算 {pct(budget)}</span>
          </dd>
        </div>
        <div className="rounded border border-neutral-800 bg-[#0f0f0f] p-2">
          <dt className="text-neutral-500">MCE</dt>
          <dd className="mt-0.5 text-neutral-200">{report ? pct(report.mce, 1) : "—"}</dd>
        </div>
        <div className="rounded border border-neutral-800 bg-[#0f0f0f] p-2">
          <dt className="text-neutral-500">Brier</dt>
          <dd className="mt-0.5 text-neutral-200">{report ? report.brier.toFixed(3) : "—"}</dd>
        </div>
      </dl>

      {!report ? (
        <p className="mt-3 rounded border border-neutral-800 bg-[#0f0f0f] p-3 text-xs leading-relaxed text-neutral-500">
          还没有带标签的样本。标签从哪来：在结果页点「核验 N 条」跑完一轮之后，
          面板下方会问「这一轮的结论成立吗」，点「成立 / 不成立」就记一条。
          每轮核验只落一条，所以要攒到 {50} 条以上才给结论 —— 更少的样本算出来的
          ECE 只是噪声，说「校准良好」比不说更糟。
        </p>
      ) : null}

      {report && counts.unlabeled > 0 ? (
        <p className="mt-2 font-mono text-[11px] text-neutral-600">
          另有 {counts.unlabeled} 条核验还没被标注，不进上面的任何数字。
        </p>
      ) : null}

      {report ? (
        <div className="mt-3 overflow-x-auto scroll-thin">
          <table className="w-full border-collapse font-mono text-[11px]">
            <thead>
              <tr className="text-neutral-500">
                <th className="border-b border-neutral-800 px-2 py-1 text-left font-normal">预测区间</th>
                <th className="border-b border-neutral-800 px-2 py-1 text-right font-normal">条数</th>
                <th className="border-b border-neutral-800 px-2 py-1 text-right font-normal">平均置信</th>
                <th className="border-b border-neutral-800 px-2 py-1 text-right font-normal">实际成立</th>
                <th className="border-b border-neutral-800 px-2 py-1 text-right font-normal">偏差</th>
              </tr>
            </thead>
            <tbody>
              {report.bins
                .filter((b) => b.count > 0)
                .map((b) => {
                  const gap = b.accuracy - b.confidence;
                  return (
                    <tr key={b.low}>
                      <td className="border-b border-neutral-900 px-2 py-1 text-neutral-400">
                        {binLabel(b.low, b.high)}
                      </td>
                      <td className="border-b border-neutral-900 px-2 py-1 text-right text-neutral-400">
                        {b.count}
                      </td>
                      <td className="border-b border-neutral-900 px-2 py-1 text-right text-neutral-400">
                        {pct(b.confidence, 1)}
                      </td>
                      <td className="border-b border-neutral-900 px-2 py-1 text-right text-neutral-400">
                        {pct(b.accuracy, 1)}
                      </td>
                      <td
                        className={
                          "border-b border-neutral-900 px-2 py-1 text-right " +
                          (Math.abs(gap) <= 0.05
                            ? "text-neutral-500"
                            : gap > 0
                              ? "text-emerald-500"
                              : "text-amber-500")
                        }
                      >
                        {gap > 0 ? "+" : ""}
                        {pct(gap, 1)}
                      </td>
                    </tr>
                  );
                })}
            </tbody>
          </table>
        </div>
      ) : null}

      <p className="mt-3 text-[11px] leading-relaxed text-neutral-600">
        偏差为正 = 实际比它自己说的更好（保守）；负 = 自估过高（危险的那一侧）。
        等宽分箱而不是等频：这样才能把两次运行的结果逐行对上。
      </p>
    </section>
  );
}
