
"use client";

import dynamic from "next/dynamic";
import { useMemo } from "react";
import type { Dataset, Field } from "@/lib/schemas";
import { compile } from "@/lib/compile";
import type { ModuleState } from "@/hooks/useProbe";

const Chart = dynamic(() => import("echarts-for-react"), {
  ssr: false,
  loading: () => <div className="skeleton h-full min-h-[160px] w-full rounded" />,
});

export default function ModuleCard({ module }: { module: ModuleState }) {
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
    <section className="panel relative overflow-hidden">
      <header className="flex items-center justify-between border-b border-white/6 px-3 py-2">
        <div className="flex items-center gap-2">
          <span className="text-[13px] text-[#cbd5e1]">{module.title}</span>
          <span className="rounded border border-white/10 px-1.5 py-0.5 text-[10px] uppercase tracking-widest text-[#5c6675]">
            {module.kind}
          </span>
        </div>
        {module.status === "plan" && (
          <span className="text-[10px] text-[#5c6675]">加载中…</span>
        )}
        {module.status === "error" && (
          <span className="text-[10px] text-[#fb7185]">降级：{module.errorDetail}</span>
        )}
      </header>

      <div className="px-3 py-3">
        {module.status === "plan" && <div className="skeleton h-[160px] w-full rounded" />}

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
                <Chart
                  option={compiled.option}
                  style={{ height: 240, width: "100%" }}
                  notMerge
                  opts={{ renderer: "canvas" }}
                />
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
    <div className="scroll-thin max-h-[240px] overflow-auto">
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
