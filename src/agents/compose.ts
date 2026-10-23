
import type { Dataset, ModuleSpec } from "@/lib/schemas";
import { compile, type CompileError } from "@/lib/compile";
import type { AnalysisResult } from "./analyze";

/**
 * 组装层：dataset → module。规则驱动，不交给模型自由发挥。
 * 每个模块都必须过 compile()；编译失败时该卡降级为表格（表格永远能渲染）。
 */

export type ModulePlan = {
  id: string;
  kind: ModuleSpec["kind"];
  title: string;
  w: number;
  h: number;
};

export type ComposeResult = {
  plans: ModulePlan[];
  specs: ModuleSpec[];
  errors: { id: string; spec: ModuleSpec; error: CompileError }[];
};

function specFor(ds: Dataset): ModuleSpec | null {
  switch (ds.id) {
    case "ds-timeline":
      return {
        id: "m-timeline",
        kind: "line",
        title: "话题热度时间线",
        dataset: ds.id,
        encode: { x: "day", y: "articles" },
        note: ds.name,
      };
    case "ds-owners":
      return {
        id: "m-owners",
        kind: "bar",
        title: "信源分布",
        dataset: ds.id,
        encode: { x: "owner", y: "articles" },
        note: "按稿源归属聚合，用于判断是否为同一集团的多平台转载。",
      };
    case "ds-tone":
      return {
        id: "m-tone",
        kind: "pie",
        title: "情感分布",
        dataset: ds.id,
        encode: { x: "bucket", value: "articles" },
        note: "GDELT 原生 tone 三档：>2 正 / |tone|<=2 中 / <-2 负。",
      };
    case "ds-summary":
      return {
        id: "m-summary",
        kind: "kpi",
        title: "本次检索概况",
        dataset: ds.id,
        encode: { x: "label", value: "value" },
        note: "命中条目为本地检索结果，非全网总量。",
      };
    default:
      return null;
  }
}

const SIZE: Record<ModuleSpec["kind"], { w: number; h: number }> = {
  kpi: { w: 12, h: 2 },
  line: { w: 8, h: 4 },
  bar: { w: 4, h: 4 },
  pie: { w: 4, h: 4 },
  treemap: { w: 6, h: 4 },
  map: { w: 8, h: 5 },
  table: { w: 6, h: 4 },
};

export function compose(analysis: AnalysisResult): ComposeResult {
  const specs: ModuleSpec[] = [];
  const errors: ComposeResult["errors"] = [];

  for (const ds of analysis.datasets) {
    const spec = specFor(ds);
    if (!spec) continue;

    // table/kpi 不经过 ECharts 编译器，天然可渲染。
    if (spec.kind !== "table" && spec.kind !== "kpi") {
      const result = compile(spec, ds);
      if (!result.ok) {
        errors.push({ id: spec.id, spec, error: result });
        specs.push({ ...spec, kind: "table", title: spec.title + "（已降级为表格）" });
        continue;
      }
    }
    specs.push(spec);
  }

  const plans = specs.map((s) => ({
    id: s.id,
    kind: s.kind,
    title: s.title,
    w: SIZE[s.kind].w,
    h: SIZE[s.kind].h,
  }));

  return { plans, specs, errors };
}
