"use client";

import { memo, useMemo } from "react";
import type { Dataset, Field } from "@/lib/schemas";
import { compile } from "@/lib/compile";
import type { ModuleState } from "@/hooks/useProbe";
import type { SourceRef } from "@/lib/sse";
import ChartBox from "./ChartBox";

/** compile() 的原因码，翻成人能读的一句。 */
const REASON_TEXT: Record<string, string> = {
  unknown_kind: "未知图表类型",
  unknown_dataset: "数据集缺失",
  unknown_field: "字段对不上",
  pie_constraint: "饼图约束不满足",
  mixed_units: "存在多个量纲",
  time_order: "时间轴无法排序",
  radar_constraint: "维度不足以画雷达图",
  funnel_constraint: "漏斗不满足逐级收窄",
  graph_constraint: "共现关系不足以成图",
};

/**
 * 每张卡都挂着一张 ECharts。流式期间摘要每变一个字父组件就重渲染一次，
 * 卡片若跟着重渲染，echarts-for-react 会重新走一遍 option diff —— 全部白干。
 * memo 之后：module / sources 引用不变就不进 render（useProbe 是整体替换 state，
 * 只有变化的那张卡的 module 引用才会变）。
 */
function ModuleCard({
  module,
  sources = [],
  draggable = false,
  animation = true,
}: {
  module: ModuleState;
  sources?: SourceRef[];
  /** 仅在布局解锁（done 之后）时为 true；false 时不渲染拖拽把手。 */
  draggable?: boolean;
  /** 设置里可关掉图表入场动画：关掉就直接出终态，少掉一次 240ms 的逐帧重绘。 */
  animation?: boolean;
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
    const out = compile(module.spec, dataset);
    if (animation || !out.ok) return out;
    return { ...out, option: { ...out.option, animation: false } };
  }, [module.spec, dataset, animation]);

  return (
    <section
      className="panel flex h-full flex-col overflow-hidden"
      data-module-id={module.id}
    >
      <header className="flex items-center justify-between gap-3 px-5 pb-2 pt-4">
        <div className="flex min-w-0 items-center gap-2.5">
          {draggable && (
            <span
              className="card-drag-handle shrink-0 cursor-grab select-none text-neutral-600 transition-colors hover:text-neutral-300"
              title="拖拽移动；拖右下角改尺寸"
              aria-hidden
            >
              ⠿
            </span>
          )}
          <span className="truncate text-base font-semibold text-white">{module.title}</span>
          <span className="shrink-0 rounded border border-neutral-700 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.1em] text-neutral-400">
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
            <summary className="cursor-pointer select-none list-none rounded border border-neutral-800 px-2 py-0.5 font-mono text-[10px] text-neutral-400 transition-colors hover:border-neutral-600 hover:text-white">
              溯源 {cited.length} 条
            </summary>
            <div className="scroll-thin absolute right-0 top-7 z-20 max-h-56 w-80 overflow-auto rounded-md border border-neutral-800 bg-[#111] p-1">
              {cited.map((s) => (
                <a
                  key={s.id}
                  href={s.url}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="block truncate rounded px-2 py-1.5 text-[11px] text-neutral-400 transition-colors hover:bg-neutral-800 hover:text-white"
                  title={s.title}
                >
                  {s.title}
                </a>
              ))}
            </div>
          </details>
        )}
        {module.status === "error" && (
          <span className="shrink-0 font-mono text-[10px] text-red-400">
            降级为表格：{REASON_TEXT[module.errorDetail ?? ""] ?? module.errorDetail}
          </span>
        )}
      </header>

      <div className="flex min-h-0 flex-1 flex-col px-5 pb-5 pt-2">
        {module.status === "plan" && <div className="skeleton min-h-[160px] w-full flex-1 rounded-md" />}

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
                <ChartBox option={compiled.option} />
              ) : (
                <>
                  <div className="mb-2 text-[11px] text-red-400">
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
    <div className="grid grid-cols-2 gap-2.5 md:grid-cols-4">
      {rows.map((r, i) => (
        <div
          key={i}
          className="rounded-md border border-neutral-800 bg-[#0f0f0f] px-4 py-3 transition-colors hover:border-neutral-600"
        >
          <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-neutral-600">
            {String(r.label ?? "—")}
          </div>
          <div className="mt-1.5 font-mono text-2xl font-bold tabular-nums text-white">
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
                className="border-b border-neutral-800 pb-1.5 pr-3 font-mono text-[10px] font-normal uppercase tracking-[0.1em] text-neutral-500"
              >
                {f.name}
                {f.unit ? " (" + f.unit + ")" : ""}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="text-neutral-300 transition-colors hover:bg-neutral-800/40">
              {fields.map((f) => (
                <td
                  key={f.name}
                  className="border-b border-neutral-800/60 py-1.5 pr-3 font-mono tabular-nums"
                >
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

export default memo(ModuleCard);
