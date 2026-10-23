
import type { Dataset, ModuleSpec } from "@/lib/schemas";
import { compile, type CompileError } from "@/lib/compile";
import { MODULE_SIZE } from "@/lib/module-catalog";
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
    case "ds-hours":
      return {
        id: "m-hours",
        kind: "heatmap",
        title: "发布时段分布",
        dataset: ds.id,
        encode: { x: "weekday", y: "hour", value: "articles" },
        note: "按香港时区落格：横轴一天里的小时，纵轴星期。空格是真的没有条目。",
      };
    case "ds-weekday":
      return {
        id: "m-weekday",
        kind: "radar",
        title: "星期分布",
        dataset: ds.id,
        encode: { x: "weekday", value: "articles" },
        note: "只画有稿子的那几天，缺的那天不补 0。",
      };
    case "ds-terms":
      return {
        id: "m-terms",
        kind: "graph",
        title: "标题专名共现",
        dataset: ds.id,
        encode: { x: "from", y: "to", value: "weight" },
        note: "两个专名同时出现在多少条标题里；节点越大，跟它共现的专名越多。",
      };
    case "ds-flow":
      return {
        id: "m-flow",
        kind: "funnel",
        title: "检索收敛漏斗",
        dataset: ds.id,
        encode: { x: "stage", value: "articles" },
        note: "每一级都是上一级的子集，所以只减不增。",
      };
    case "ds-fresh":
      return {
        id: "m-fresh",
        kind: "gauge",
        title: "24 小时新鲜度",
        dataset: ds.id,
        encode: { x: "label", value: "percent" },
        note: "分母是这次有发布时间的条目，不是全网。",
      };
    case "ds-tone-scatter":
      return {
        id: "m-tone-scatter",
        kind: "scatter",
        title: "时距与情感",
        dataset: ds.id,
        encode: { x: "hours", y: "tone" },
        note: "横轴距今小时数（最多 7 天），纵轴 GDELT tone。",
      };
    default:
      return null;
  }
}

/**
 * 尺寸表搬到了 src/lib/module-catalog.ts：「一句话生成模块」在前端插入新卡片时
 * 也要用同一张表，两个地方各写一份迟早会不一致。
 */

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
    w: MODULE_SIZE[s.kind].w,
    h: MODULE_SIZE[s.kind].h,
  }));

  return { plans, specs, errors };
}