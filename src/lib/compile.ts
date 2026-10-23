
import type { Dataset, ModuleSpec } from "./schemas";

/**
 * ModuleSpec → ECharts option（PRD 2.4）。
 *
 * 模型不再直接输出 ECharts option。原因：option 的幻觉有相当一部分是“语法合法但
 * 语义错”——绝对值当比率、时间轴倒序、饼图加总不等 100、异量纲同轴。这类错误
 * JSON.parse 抓不到，只能靠编译器白名单拒绝。拒绝优于修正。
 */

export const PALETTE = [
  "#5eead4",
  "#818cf8",
  "#f472b6",
  "#fbbf24",
  "#38bdf8",
  "#a3e635",
  "#fb923c",
];

export type CompileError =
  | { ok: false; reason: "unknown_kind" }
  | { ok: false; reason: "unknown_dataset"; detail: string }
  | { ok: false; reason: "unknown_field"; detail: string }
  | { ok: false; reason: "pie_constraint"; detail: string }
  | { ok: false; reason: "mixed_units"; detail: string }
  | { ok: false; reason: "time_order"; detail: string };

export type CompileOk = { ok: true; option: Record<string, unknown> };
export type CompileResult = CompileOk | CompileError;

const BASE: Record<string, unknown> = {
  backgroundColor: "transparent",
  color: PALETTE,
  textStyle: {
    color: "#cbd5e1",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  },
  grid: { left: 48, right: 24, top: 48, bottom: 40, containLabel: true },
  tooltip: {
    trigger: "axis",
    backgroundColor: "rgba(10,12,16,0.92)",
    borderColor: "rgba(255,255,255,0.12)",
    textStyle: { color: "#e2e8f0", fontSize: 12 },
  },
};

function categoryAxis(name: string, unit?: string) {
  return {
    type: "category",
    name: unit ? name + " (" + unit + ")" : name,
    axisLine: { lineStyle: { color: "rgba(255,255,255,0.14)" } },
    axisLabel: { color: "#94a3b8", fontSize: 11 },
    splitLine: { show: false },
  };
}

export function compile(spec: ModuleSpec, dataset: Dataset | undefined): CompileResult {
  if (spec.kind === "table" || spec.kind === "kpi") {
    // 表格与 KPI 不需要 ECharts，由 React 组件直接渲染 dataset。
    return { ok: true, option: {} };
  }
  if (!dataset || dataset.id !== spec.dataset) {
    return { ok: false, reason: "unknown_dataset", detail: spec.dataset };
  }

  const fieldNames = new Set(dataset.fields.map((f) => f.name));
  const field = (name?: string) =>
    name ? dataset.fields.find((f) => f.name === name) : undefined;

  for (const key of ["x", "y", "value", "series"]) {
    const target = spec.encode[key];
    if (target && !fieldNames.has(target)) {
      return { ok: false, reason: "unknown_field", detail: key + "=" + target };
    }
  }

  const xField = field(spec.encode.x);
  const yField = field(spec.encode.y);
  const vField = field(spec.encode.value ?? spec.encode.y);

  switch (spec.kind) {
    case "pie": {
      if (!vField) return { ok: false, reason: "pie_constraint", detail: "missing value field" };
      if (spec.encode.series) {
        return { ok: false, reason: "pie_constraint", detail: "pie allows exactly one series" };
      }
      const rows = dataset.rows.filter((r) => {
        const v = r[vField.name];
        return typeof v === "number" && v > 0;
      });
      if (rows.length === 0) {
        return { ok: false, reason: "pie_constraint", detail: "no positive values" };
      }
      if (rows.length > 8) {
        return {
          ok: false,
          reason: "pie_constraint",
          detail: rows.length + " slices > 8",
        };
      }
      const labelField = xField ?? dataset.fields.find((f) => f.type === "string");
      if (!labelField) {
        return { ok: false, reason: "pie_constraint", detail: "no label field" };
      }
      return {
        ok: true,
        option: {
          ...BASE,
          tooltip: { ...(BASE.tooltip as object), trigger: "item" },
          legend: { bottom: 0, textStyle: { color: "#94a3b8", fontSize: 11 } },
          series: [
            {
              type: "pie",
              radius: ["42%", "68%"],
              itemStyle: { borderColor: "#07080a", borderWidth: 2 },
              label: { color: "#cbd5e1", fontSize: 11 },
              data: rows.map((r) => ({
                name: String(r[labelField.name] ?? "—"),
                value: Number(r[vField.name]),
              })),
            },
          ],
        },
      };
    }

    case "treemap": {
      if (!vField) return { ok: false, reason: "unknown_field", detail: "missing value" };
      const labelField = xField ?? dataset.fields.find((f) => f.type === "string");
      if (!labelField) {
        return { ok: false, reason: "unknown_field", detail: "no label field" };
      }
      return {
        ok: true,
        option: {
          ...BASE,
          series: [
            {
              type: "treemap",
              roam: false,
              nodeClick: false,
              breadcrumb: { show: false },
              itemStyle: { borderColor: "#07080a", borderWidth: 2, gapWidth: 2 },
              label: { color: "#0b0d10", fontSize: 11, fontWeight: 600 },
              data: dataset.rows.map((r) => ({
                name: String(r[labelField.name] ?? "—"),
                value: Number(r[vField.name] ?? 0),
              })),
            },
          ],
        },
      };
    }

    case "map": {
      // 骨架阶段用散点代替真地图：注册 geo 需要额外 geojson 资源（Phase 2）。
      if (!xField || !yField) {
        return { ok: false, reason: "unknown_field", detail: "map needs x(lon) and y(lat)" };
      }
      return {
        ok: true,
        option: {
          ...BASE,
          xAxis: { show: false, type: "value" },
          yAxis: { show: false, type: "value" },
          series: [
            {
              type: "scatter",
              symbolSize: 6,
              itemStyle: { color: "#5eead4", opacity: 0.55 },
              data: dataset.rows.map((r) => [
                Number(r[xField.name]),
                Number(r[yField.name]),
              ]),
            },
          ],
        },
      };
    }

    case "bar":
    case "line": {
      if (!xField) return { ok: false, reason: "unknown_field", detail: "missing x" };
      const seriesFields = spec.encode.series
        ? [field(spec.encode.series)].filter((f) => f !== undefined)
        : yField
          ? [yField]
          : [];

      if (seriesFields.length === 0) {
        return { ok: false, reason: "unknown_field", detail: "missing y/series" };
      }

      // 异量纲检测：同轴多序列单位不同 → 拒绝（PRD 2.4）。
      const units = new Set(seriesFields.map((f) => f?.unit ?? ""));
      if (units.size > 1) {
        return { ok: false, reason: "mixed_units", detail: [...units].join(" vs ") };
      }

      // 时间轴由编译器升序排序，不信任模型给的顺序。
      const rows =
        xField.type === "time"
          ? [...dataset.rows].sort(
              (a, b) => Date.parse(String(a[xField.name])) - Date.parse(String(b[xField.name])),
            )
          : dataset.rows;

      if (xField.type === "time") {
        for (const r of rows) {
          if (Number.isNaN(Date.parse(String(r[xField.name])))) {
            return { ok: false, reason: "time_order", detail: "unparsable time in dataset" };
          }
        }
      }

      return {
        ok: true,
        option: {
          ...BASE,
          xAxis: categoryAxis(xField.name, xField.unit),
          yAxis: {
            type: "value",
            name: seriesFields[0]?.unit ?? "",
            splitLine: { lineStyle: { color: "rgba(255,255,255,0.06)" } },
            axisLabel: { color: "#94a3b8", fontSize: 11 },
          },
          series: seriesFields.map((f, idx) => ({
            type: spec.kind,
            name: f?.name ?? "value",
            smooth: spec.kind === "line",
            showSymbol: rows.length < 24,
            lineStyle: { width: 2, color: PALETTE[idx % PALETTE.length] },
            areaStyle:
              spec.kind === "line"
                ? { opacity: 0.08, color: PALETTE[idx % PALETTE.length] }
                : undefined,
            barMaxWidth: 28,
            itemStyle: {
              color: PALETTE[idx % PALETTE.length],
              borderRadius: spec.kind === "bar" ? [3, 3, 0, 0] : 0,
            },
            data: rows.map((r) => r[f?.name ?? ""]),
          })),
        },
      };
    }

    default:
      return { ok: false, reason: "unknown_kind" };
  }
}
