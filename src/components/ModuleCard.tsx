
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
  loading: () => <div className="skeleton h-full min-h-[160px] w-full rounded" />,
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
    <section className="panel relative flex h-full flex-col overflow-hidden">
      <header className="flex items-center justify-between border-b border-white/6 px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          {draggable && (
            <span
              className="card-drag-handle shrink-0 cursor-grab select-none px-0.5 text-[#3f4854] hover:text-[#7b8798]"
              title="拖拽移动；拖右下角改尺寸"
              aria-hidden
            >
              ⠿
            </span>
          )}
          <span className="truncate text-[13px] text-[#cbd5e1]">{module.title}</span>
          <span className="rounded border border-white/10 px-1.5 py-0.5 text-[10px] uppercase tracking-widest text-[#5c6675]">
            {module.kind}
          </span>
        </div>
        {module.status === "plan" && (
          <span className="text-[10px] text-[#5c6675]">加载中…</span>
        )}
        {module.status !== "plan" && cited.length > 0 && (
          // PRD 附录 C：模块里的每个数字都要能在两次点击内回到原文。
          // 这里给出该模块实际引用的条目，不是全量信源 —— 全量等于没指认。
          <details className="relative">
            <summary className="cursor-pointer select-none list-none rounded border border-white/10 px-1.5 py-0.5 text-[10px] text-[#7b8798] hover:border-white/25 hover:text-[#cbd5e1]">
              溯源 {cited.length} 条
            </summary>
            <div className="scroll-thin absolute right-0 top-6 z-20 max-h-56 w-80 overflow-auto rounded border border-white/12 bg-[#0b0d11] p-1 shadow-lg">
              {cited.map((s) => (
                <a
                  key={s.id}
                  href={s.url}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="block truncate px-2 py-1 text-[11px] text-[#94a3b8] hover:bg-white/5 hover:text-[#5eead4]"
                  title={s.title}
                >
                  {s.title}
                </a>
              ))}
            </div>
          </details>
        )}
        {module.status === "error" && (
          <span className="text-[10px] text-[#fb7185]">
            降级为表格：{REASON_TEXT[module.errorDetail ?? ""] ?? module.errorDetail}
          </span>
        )}
      </header>

      <div className="flex min-h-0 flex-1 flex-col px-3 py-3">
        {module.status === "plan" && <div className="skeleton min-h-[160px] w-full flex-1 rounded" />}

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
          <p className="mt-2 border-t border-white/6 pt-2 text-[10px] leading-relaxed text-[#5c6675]">
            {module.spec.note}
          </p>
        )}
      </div>
    </section>
  );
}

function KpiGrid({ rows }: { rows: Record<string, string | number | null>[] }) {
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
      {rows.map((r, i) => (
        <div key={i} className="rounded border border-white/8 bg-white/[0.02] px-3 py-2">
          <div className="text-[10px] uppercase tracking-wider text-[#5c6675]">
            {String(r.label ?? "—")}
          </div>
          <div className="mt-1 text-xl text-[#e2e8f0]">
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
    return <div className="text-[11px] text-[#5c6675]">无数据</div>;
  }
  return (
    <div className="scroll-thin h-full min-h-0 overflow-auto">
      <table className="w-full border-collapse text-[11px]">
        <thead>
          <tr className="text-left text-[#5c6675]">
            {fields.map((f) => (
              <th key={f.name} className="border-b border-white/8 py-1 pr-3 font-normal">
                {f.name}
                {f.unit ? " (" + f.unit + ")" : ""}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="text-[#cbd5e1]">
              {fields.map((f) => (
                <td key={f.name} className="border-b border-white/4 py-1 pr-3">
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