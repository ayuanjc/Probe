"use client";

import dynamic from "next/dynamic";
import { useMemo } from "react";
import type { Dataset, Field } from "@/lib/schemas";
import { compile } from "@/lib/compile";
import type { ModuleState } from "@/hooks/useProbe";
import type { SourceRef } from "@/lib/sse";

/** compile() 的原因码，翻成人能读的一句。 */
const REASON_TEXT: Record<string, string> = {
  unknown_kind: "未知图表类型",
  unknown_dataset: "数据集缺失",
  unknown_field: "字段对不上",
  pie_constraint: "饼图约束不满足",
  mixed_units: "存在多个量纲",
  time_order: "时间轴无法排序",
};

const Chart = dynamic(() => import("echarts-for-react"), {
  ssr: false,
  loading: () => <div className="skeleton h-full min-h-[160px] w-full rounded-lg" />,
});

export default function ModuleCard({
  module,
  sources = [],
  draggable = false,
}: {
  module: ModuleState;
  sources?: SourceRef[];
  /** 仅在布局解锁（done 之后）时为 true；false 时不渲染拖拽把手。 */
  draggable?: boolean;
}) {
  const cited = useMemo(() => {
    const ids = new Set(module.sourceIds ?? []);
    return sources.filter((s) => ids.has(s.id));
  }, [module.sourceIds, sources]);
  const dataset: Dataset | undefined = useMemo(() => {
    if (!module.spec || !module.rows || !module.fields) return undefined;
    return {
      id: module.spec.dataset,
      name: module.spec.title,
      fields: module.fields,
      rows: module.rows,
    };
  }, [module.spec, module.rows, module.fields]);

  const compiled = useMemo(() => {
    if (!module.spec || !dataset) return null;
    return compile(module.spec, dataset);
  }, [module.spec, dataset]);

  return (
    <section className="panel flex h-full flex-col overflow-hidden">
      <header className="flex items-center justify-between gap-3 px-6 pb-2 pt-5">
        <div className="flex min-w-0 items-center gap-2.5">
          {draggable && (
            <span
              className="card-drag-handle shrink-0 cursor-grab select-none text-neutral-600 transition-colors hover:text-cyan-400"
              title="拖拽移动；拖右下角改尺寸"
              aria-hidden
            >
              ⠿
            </span>
          )}
          <span className="truncate text-base font-semibold text-white">{module.title}</span>
          <span className="shrink-0 rounded border border-white/10 bg-white/10 px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.12em] text-neutral-300">
            {module.kind}
          </span>
        </div>
        {module.status === "plan" && (
          <span className="shrink-0 font-mono text-[10px] text-neutral-600">加载中…</span>
        )}
        {module.status !== "plan" && cited.length > 0 && (
          // PRD 附录 C：模块里的每个数字都要能在两次点击内回到原文。
          // 这里给出该模块实际引用的条目，不是全量信源 —— 全量等于没指认。
          <details className="relative shrink-0">
            <summary className="cursor-pointer select-none list-none rounded border border-white/10 bg-white/[0.04] px-2.5 py-0.5 font-mono text-[10px] text-neutral-300 transition-colors hover:border-cyan-500/40 hover:bg-cyan-500/10 hover:text-cyan-300">
              溯源 {cited.length} 条
            </summary>
            <div className="scroll-thin absolute right-0 top-7 z-20 max-h-56 w-80 overflow-auto rounded-lg border border-white/10 bg-[#0a0a0c]/95 p-1.5 shadow-[0_30px_80px_-30px_rgba(0,0,0,0.95)] backdrop-blur-xl">
              {cited.map((s) => (
                <a
                  key={s.id}
                  href={s.url}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="block truncate rounded px-2 py-1.5 text-[11px] text-neutral-300 transition-colors hover:bg-cyan-500/10 hover:text-cyan-300"
                  title={s.title}
                >
                  {s.title}
                </a>
              ))}
            </div>
          </details>
        )}
        {module.status === "error" && (
          <span className="shrink-0 font-mono text-[10px] text-[#fb7185]">
            降级为表格：{REASON_TEXT[module.errorDetail ?? ""] ?? module.errorDetail}
          </span>
        )}
      </header>

      <div className="flex min-h-0 flex-1 flex-col px-6 pb-6 pt-2">
        {module.status === "plan" && <div className="skeleton min-h-[160px] w-full flex-1 rounded-lg" />}

        {module.status !== "plan" && module.spec?.kind === "kpi" && (
          <KpiGrid rows={module.rows ?? []} />
        )}

        {module.status !== "plan" && module.spec?.kind === "table" && (
          <DataTable fields={module.fields ?? []} rows={module.rows ?? []} />
        )}

        {module.status !== "plan" &&
          module.spec &&
          module.spec.kind !== "kpi" &&
          module.spec.kind !== "table" && (
            <>
              {compiled && compiled.ok ? (
                // 高度交给网格单元：卡片被拖高时图跟着长，而不是留一块空白。
                <div className="min-h-[180px] flex-1">
                  <Chart
                    option={compiled.option}
                    style={{ height: "100%", width: "100%" }}
                    notMerge
                    opts={{ renderer: "canvas" }}
                  />
                </div>
              ) : (
                <>
                  <div className="mb-2 text-[11px] text-[#fb7185]">
                    图表规格未通过编译校验（{compiled && !compiled.ok ? compiled.reason : "unknown"}），已降级为表格。
                  </div>
                  <DataTable fields={module.fields ?? []} rows={module.rows ?? []} />
                </>
              )}
            </>
          )}

        {module.spec?.note && (
          <p className="mt-3 text-[10px] leading-relaxed text-neutral-600">{module.spec.note}</p>
        )}
      </div>
    </section>
  );
}

function KpiGrid({ rows }: { rows: Record<string, string | number | null>[] }) {
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
      {rows.map((r, i) => (
        <div
          key={i}
          className="rounded-lg border border-white/5 bg-white/[0.02] px-4 py-3 transition-colors hover:border-cyan-500/20 hover:bg-cyan-500/[0.04]"
        >
          <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-neutral-500">
            {String(r.label ?? "—")}
          </div>
          <div className="mt-1.5 font-mono text-2xl font-bold tabular-nums text-cyan-400">
            {typeof r.value === "number" ? r.value.toLocaleString("en-US") : (r.value ?? "—")}
          </div>
        </div>
      ))}
    </div>
  );
}

function DataTable({
  fields,
  rows,
}: {
  fields: Field[];
  rows: Record<string, string | number | null>[];
}) {
  if (fields.length === 0 || rows.length === 0) {
    return <div className="text-[11px] text-neutral-500">无数据</div>;
  }
  return (
    <div className="scroll-thin h-full min-h-0 overflow-auto">
      <table className="w-full border-collapse text-[11px]">
        <thead>
          <tr className="text-left">
            {fields.map((f) => (
              <th
                key={f.name}
                className="border-b border-white/10 pb-1.5 pr-3 font-mono text-[10px] font-normal uppercase tracking-[0.12em] text-cyan-400/80"
              >
                {f.name}
                {f.unit ? " (" + f.unit + ")" : ""}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="text-neutral-300 transition-colors hover:bg-cyan-500/[0.05]">
              {fields.map((f) => (
                <td key={f.name} className="border-b border-white/5 py-1.5 pr-3 font-mono tabular-nums">
                  {r[f.name] === null || r[f.name] === undefined ? "—" : String(r[f.name])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
