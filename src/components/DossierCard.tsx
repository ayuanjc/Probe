"use client";

import type { ClaimStatus, DossierResult } from "@/lib/dossier";

/**
 * 文档级吻合度卡片（界面契约见 分析文档 §8）。
 *
 * 三个可见数字，别的都收进 detail：
 *   主数字 = 有效吻合度 + Wilson 区间（n_eff 太小就先不给数）；
 *   副标签 = n_eff（「相当于几个独立来源」）；
 *   警示条 = 假共识溢价（只在真的被转载撑起来时才亮）。
 *
 * 七个数平铺的后果不是信息更全，是一个都不读。
 */

const STATUS_STYLE: Record<ClaimStatus, string> = {
  supported: "text-emerald-500 border-emerald-500/30 bg-emerald-500/10",
  contradicted: "text-red-500 border-red-500/30 bg-red-500/10",
  unverified: "text-neutral-400 border-neutral-700 bg-neutral-800/40",
  unverifiable: "text-neutral-500 border-dashed border-neutral-700 bg-transparent",
};

function pct(x: number): string {
  return (x * 100).toFixed(0) + "%";
}

export default function DossierCard({ result }: { result: DossierResult }) {
  const { view, counts, blocked, demo } = result;
  const agreement = view.agreement;
  const tooFewSources = view.nEff < 2;

  return (
    <section className="rounded-md border border-neutral-800 bg-[#111] p-4 text-[12px] leading-relaxed text-neutral-400">
      <header className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h3 className="text-white">外部吻合度</h3>
          <span className="font-mono text-[10px] text-neutral-500">按 owner 加权 · 不含自证</span>
          {demo ? (
            <span className="rounded border border-yellow-500/30 bg-yellow-500/10 px-1.5 py-0.5 font-mono text-[10px] text-yellow-500">
              演示数据
            </span>
          ) : null}
        </div>
        <div className="font-mono text-[11px] text-neutral-500">
          已判定 {counts.judged} / 可核验 {counts.verifiable} · 跳过 {counts.unverifiable}
        </div>
      </header>

      {agreement && !tooFewSources ? (
        <div className="flex items-end gap-3">
          <div className="font-mono text-3xl font-bold tabular-nums text-blue-500">{pct(agreement.value)}</div>
          <div className="pb-1 font-mono text-[11px] text-neutral-500">
            95% 区间 {pct(agreement.low)}–{pct(agreement.high)}
          </div>
          <div
            className="mb-0.5 ml-auto rounded border border-neutral-700 px-2 py-0.5 font-mono text-[11px] text-neutral-300"
            title="有效独立源数 = (Σw)² / Σw²；转载按 0.3 计，同一 owner 只算一票"
          >
            ≈{view.nEff.toFixed(1)} 个独立源
          </div>
        </div>
      ) : (
        <div className="flex items-end gap-3">
          <div className="text-lg text-neutral-300">
            {tooFewSources && agreement ? "无独立证据" : "本轮无外部核验"}
          </div>
          <div className="pb-1 font-mono text-[11px] text-neutral-500">≈{view.nEff.toFixed(1)} 个独立源</div>
        </div>
      )}

      <p className="mt-2 text-[11px] text-neutral-500">
        {tooFewSources && agreement
          ? "只有一个独立来源投票，给不出区间 —— 一个来源的吻合度不是吻合度。"
          : agreement
            ? "这是外部证据对本文断言的加权支持比例，不是真假判决。"
            : blocked === "all_unverifiable"
              ? "本轮断言全部是因果 / 观点 / 预测类，按定义不可核验 —— 只有可核验率有意义。"
              : "本轮没有带回任何留出集证据：界面显示「没有核过」，不显示 0 分。"}
      </p>

      {view.fakeConsensus ? (
        <div className="mt-3 rounded border border-yellow-500/30 bg-yellow-500/10 px-3 py-2 text-[11px] text-yellow-500">
          <span className="font-mono">
            假共识溢价 +{(view.fakeConsensus.premium * 100).toFixed(0)}pt
          </span>
          <span className="ml-2 text-yellow-500/80">
            {view.fakeConsensus.nSupport} 票支持（权重 {view.fakeConsensus.supportMass.toFixed(1)}）对
            {view.fakeConsensus.nContra} 票反对（权重 {view.fakeConsensus.contraMass.toFixed(1)}）：
            按条数算比按 owner 算更支持 —— 差额来自同源转载。
          </span>
        </div>
      ) : null}

      <details className="group mt-3">
        <summary className="cursor-pointer select-none list-none font-mono text-[10px] text-neutral-500 hover:text-neutral-300">
          其余口径 ▾
        </summary>
        <div className="mt-2 grid grid-cols-2 gap-x-6 gap-y-1 font-mono text-[10px] text-neutral-500">
          <Key label="朴素吻合度" value={pct(view.tooltip.naive)} />
          <Key
            label="Fleiss κ"
            value={
              view.tooltip.kappa === null
                ? "未计（单判定者）"
                : view.tooltip.kappa.toFixed(3) + " · P_e " + (view.tooltip.kappaExpected ?? 0).toFixed(3)
            }
          />
          <Key label="Gwet AC1" value={view.tooltip.ac1 === null ? "未计" : view.tooltip.ac1.toFixed(3)} />
          <Key
            label="未核验占比"
            value={view.tooltip.nSilent + " / " + (view.tooltip.nChecked + view.tooltip.nSilent)}
          />
          <Key
            label="可核验率"
            value={view.tooltip.coverage === null ? "未计" : pct(view.tooltip.coverage)}
          />
          <Key label="证据权重和" value={view.tooltip.supportMass.toFixed(2) + " / " + view.tooltip.contraMass.toFixed(2)} />
        </div>
      </details>

      {result.rows.length > 0 ? (
        <ul className="mt-4 divide-y divide-neutral-800 border-t border-neutral-800">
          {result.rows.map((row) => (
            <li key={row.claimIndex} className="py-2">
              <div className="flex items-start gap-2">
                <span
                  className={
                    "shrink-0 rounded border px-1.5 py-0.5 font-mono text-[10px] " + STATUS_STYLE[row.status]
                  }
                  title={row.kind + " · 权重 " + row.weight}
                >
                  {row.label}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="text-neutral-300">
                    <span className="font-mono text-neutral-500">{row.attr}</span> = {row.value}
                  </div>
                  <blockquote className="mt-0.5 border-l-2 border-neutral-800 pl-2 font-mono text-[10px] text-neutral-500">
                    {row.quote}
                  </blockquote>
                  {row.reason ? (
                    <div className="mt-1 text-[10px] text-neutral-600">{row.reason}</div>
                  ) : null}
                </div>
              </div>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function Key({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span>{label}</span>
      <span className="tabular-nums text-neutral-300">{value}</span>
    </div>
  );
}
