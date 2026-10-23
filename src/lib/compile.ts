
import type { Dataset, ModuleSpec } from "./schemas";

/**
 * ModuleSpec → ECharts option（PRD 2.4）。
 *
 * 模型不再直接输出 ECharts option。原因：option 的幻觉有相当一部分是“语法合法但
 * 语义错”——绝对值当比率、时间轴倒序、饼图加总不等 100、异量纲同轴。这类错误
 * JSON.parse 抓不到，只能靠编译器白名单拒绝。拒绝优于修正。
 */

/** 霓虹赛博色板：青色打头（品牌色），其余保持高饱和、低明度背景上可读。 */
export const PALETTE = [
  "#22d3ee",
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
  | { ok: false; reason: "time_order"; detail: string }
  | { ok: false; reason: "radar_constraint"; detail: string }
  | { ok: false; reason: "funnel_constraint"; detail: string }
  | { ok: false; reason: "graph_constraint"; detail: string };

export type CompileOk = { ok: true; option: Record<string, unknown> };
export type CompileResult = CompileOk | CompileError;

const BASE: Record<string, unknown> = {
  backgroundColor: "transparent",
  /**
   * ECharts 默认入场 1000ms、更新 300ms。多张卡同时上线时，那一秒里每帧都在重绘
   * canvas —— 实测滚动/交互的长动画帧就卡在这段动画尾巴上。情报工具不需要
   * "图表长出来"的仪式感，240ms 够看出变化，也够看清方向。
   */
  animationDuration: 240,
  animationDurationUpdate: 160,
  animationEasing: "cubicOut",
  animationEasingUpdate: "cubicOut",
  color: PALETTE,
  textStyle: {
    color: "#a3a3a3",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  },
  grid: { left: 48, right: 24, top: 48, bottom: 40, containLabel: true },
  tooltip: {
    trigger: "axis",
    backgroundColor: "rgba(8,10,12,0.94)",
    borderColor: "rgba(34,211,238,0.28)",
    borderWidth: 1,
    textStyle: { color: "#e5e5e5", fontSize: 12 },
  },
};

function categoryAxis(name: string, unit?: string) {
  return {
    type: "category",
    name: unit ? name + " (" + unit + ")" : name,
    axisLine: { lineStyle: { color: "rgba(255,255,255,0.12)" } },
    axisLabel: { color: "#737373", fontSize: 11 },
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

  // 白名单逐项校验：encode 里出现的每个字段名都必须是这个 dataset 真有的。
  // 早先只查 x/y/value/series 四个键，新增的图表（graph 的 from/to、funnel 的 stage）
  // 等于绕开了校验 —— 字段写错会一路走到 ECharts 里变成一块空白。
  for (const [key, target] of Object.entries(spec.encode)) {
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
              itemStyle: { color: "#22d3ee", opacity: 0.6 },
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

    case "heatmap": {
      // 二维计数（星期 × 小时）：一张图看完"这批报道在什么时间落点"。
      if (!xField || !yField || !vField) {
        return { ok: false, reason: "unknown_field", detail: "heatmap needs x/y/value" };
      }
      const xs = [...new Set(dataset.rows.map((r) => String(r[xField.name] ?? "—")))];
      const ys = [...new Set(dataset.rows.map((r) => String(r[yField.name] ?? "—")))].sort(
        (a, b) => Number(a) - Number(b) || a.localeCompare(b),
      );
      const heatMax = Math.max(1, ...dataset.rows.map((r) => Number(r[vField.name] ?? 0)));
      return {
        ok: true,
        option: {
          ...BASE,
          tooltip: { ...(BASE.tooltip as object), trigger: "item" },
          grid: { left: 30, right: 16, top: 20, bottom: 52, containLabel: true },
          xAxis: {
            type: "category",
            data: xs,
            axisLine: { lineStyle: { color: "rgba(255,255,255,0.12)" } },
            axisLabel: { color: "#737373", fontSize: 10 },
            splitLine: { show: false },
          },
          yAxis: {
            type: "category",
            data: ys,
            axisLine: { lineStyle: { color: "rgba(255,255,255,0.12)" } },
            axisLabel: { color: "#737373", fontSize: 10 },
            splitLine: { show: false },
          },
          visualMap: {
            min: 0,
            max: heatMax,
            calculable: false,
            orient: "horizontal",
            left: "center",
            bottom: 6,
            itemWidth: 10,
            itemHeight: 60,
            textStyle: { color: "#737373", fontSize: 10 },
            inRange: { color: ["#0b1e24", "#155e6b", "#0891b2", "#22d3ee", "#a5f3fc"] },
          },
          series: [
            {
              type: "heatmap",
              data: dataset.rows.map((r) => [
                String(r[xField.name] ?? "—"),
                String(r[yField.name] ?? "—"),
                Number(r[vField.name] ?? 0),
              ]),
              itemStyle: { borderColor: "#07080a", borderWidth: 1 },
              emphasis: { itemStyle: { borderColor: "#ffffff", borderWidth: 1 } },
            },
          ],
        },
      };
    }

    case "radar": {
      // 七个方向必须是同一量纲的计数；少于 3 个方向的雷达图只是多边形噪声。
      if (!xField || !vField) {
        return { ok: false, reason: "unknown_field", detail: "radar needs x/value" };
      }
      const radarRows = dataset.rows.slice(0, 8);
      if (radarRows.length < 3) {
        return { ok: false, reason: "radar_constraint", detail: "need >=3 dimensions" };
      }
      const radarMax = Math.max(1, ...radarRows.map((r) => Number(r[vField.name] ?? 0)));
      return {
        ok: true,
        option: {
          ...BASE,
          tooltip: { ...(BASE.tooltip as object), trigger: "item" },
          radar: {
            indicator: radarRows.map((r) => ({
              name: String(r[xField.name] ?? "—"),
              max: Math.ceil(radarMax * 1.15),
            })),
            center: ["50%", "54%"],
            radius: "64%",
            axisName: { color: "#a3a3a3", fontSize: 10 },
            splitLine: { lineStyle: { color: "rgba(255,255,255,0.08)" } },
            splitArea: { show: false },
            axisLine: { lineStyle: { color: "rgba(255,255,255,0.1)" } },
          },
          series: [
            {
              type: "radar",
              symbolSize: 3,
              lineStyle: { width: 2, color: "#22d3ee" },
              itemStyle: { color: "#22d3ee" },
              areaStyle: { opacity: 0.14, color: "#22d3ee" },
              data: [
                {
                  value: radarRows.map((r) => Number(r[vField.name] ?? 0)),
                  name: "篇数",
                },
              ],
            },
          ],
        },
      };
    }

    case "graph": {
      // 共现网络：边从 dataset 的 from/to 来，节点度数决定半径（枢纽一眼看得出）。
      if (!xField || !yField) {
        return { ok: false, reason: "unknown_field", detail: "graph needs x(from)/y(to)" };
      }
      const edges = dataset.rows
        .map((r) => ({
          source: String(r[xField.name] ?? ""),
          target: String(r[yField.name] ?? ""),
          value: vField ? Number(r[vField.name] ?? 1) : 1,
        }))
        .filter((e) => e.source && e.target && e.source !== e.target);
      if (edges.length === 0) {
        return { ok: false, reason: "graph_constraint", detail: "no edges" };
      }
      const degree = new Map<string, number>();
      for (const e of edges) {
        degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
        degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
      }
      const nodes = [...degree.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 36)
        .map(([name, d]) => ({ name, symbolSize: 6 + Math.min(18, d * 3) }));
      const kept = new Set(nodes.map((n) => n.name));
      return {
        ok: true,
        option: {
          ...BASE,
          tooltip: { ...(BASE.tooltip as object), trigger: "item" },
          series: [
            {
              type: "graph",
              layout: "force",
              roam: false,
              draggable: false,
              force: { repulsion: 68, edgeLength: [30, 72], gravity: 0.12 },
              label: { show: true, color: "#cbd5e1", fontSize: 10, position: "right" },
              lineStyle: { color: "rgba(34,211,238,0.22)", width: 1, curveness: 0.12 },
              itemStyle: { color: "#22d3ee" },
              emphasis: {
                focus: "adjacency",
                lineStyle: { color: "#22d3ee", width: 2 },
              },
              data: nodes,
              links: edges.filter((e) => kept.has(e.source) && kept.has(e.target)),
            },
          ],
        },
      };
    }

    case "funnel": {
      // 漏斗只在"逐级收窄"时成立。某一段比上一段还大就说明数据有误，拒绝比修图诚实。
      if (!xField || !vField) {
        return { ok: false, reason: "unknown_field", detail: "funnel needs x/value" };
      }
      const stages = dataset.rows.filter(
        (r) => typeof r[vField.name] === "number" && Number(r[vField.name]) > 0,
      );
      if (stages.length < 2) {
        return { ok: false, reason: "funnel_constraint", detail: "need >=2 stages" };
      }
      for (let i = 1; i < stages.length; i++) {
        if (Number(stages[i][vField.name]) > Number(stages[i - 1][vField.name])) {
          return { ok: false, reason: "funnel_constraint", detail: "stage " + (i + 1) + " grows" };
        }
      }
      return {
        ok: true,
        option: {
          ...BASE,
          tooltip: { ...(BASE.tooltip as object), trigger: "item" },
          series: [
            {
              type: "funnel",
              left: "14%",
              right: "14%",
              top: 12,
              bottom: 12,
              minSize: "24%",
              sort: "none",
              gap: 3,
              label: { color: "#e5e5e5", fontSize: 11, formatter: "{b} {c}" },
              itemStyle: { borderColor: "#07080a", borderWidth: 1 },
              data: stages.map((r, i) => ({
                name: String(r[xField.name] ?? "—"),
                value: Number(r[vField.name]),
                itemStyle: { color: PALETTE[i % PALETTE.length] },
              })),
            },
          ],
        },
      };
    }

    case "gauge": {
      // 单值占比。> 100 的值按原始计数处理，不自作主张换算成百分比。
      if (!vField) {
        return { ok: false, reason: "unknown_field", detail: "gauge needs value" };
      }
      const gRow = dataset.rows[0];
      const gRaw = gRow ? Number(gRow[vField.name]) : NaN;
      if (!gRow || !Number.isFinite(gRaw)) {
        return { ok: false, reason: "unknown_field", detail: "gauge value not numeric" };
      }
      const isPct = gRaw >= 0 && gRaw <= 100;
      const gMax = isPct ? 100 : Math.ceil(gRaw * 1.2) || 1;
      const gLabel = xField ? String(gRow[xField.name] ?? "") : "";
      return {
        ok: true,
        option: {
          ...BASE,
          tooltip: { ...(BASE.tooltip as object), trigger: "item" },
          series: [
            {
              type: "gauge",
              startAngle: 210,
              endAngle: -30,
              min: 0,
              max: gMax,
              radius: "82%",
              center: ["50%", "56%"],
              progress: { show: true, width: 8, itemStyle: { color: "#22d3ee" } },
              axisLine: { lineStyle: { width: 8, color: [[1, "rgba(255,255,255,0.08)"]] } },
              pointer: { show: false },
              axisTick: { show: false },
              splitLine: { show: false },
              axisLabel: { show: false },
              detail: {
                fontSize: 22,
                color: "#22d3ee",
                fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                offsetCenter: [0, "0%"],
                formatter: isPct ? "{value}%" : "{value}",
              },
              title: {
                show: gLabel.length > 0,
                offsetCenter: [0, "34%"],
                color: "#71717a",
                fontSize: 11,
              },
              data: [{ value: Number(gRaw.toFixed(1)), name: gLabel }],
            },
          ],
        },
      };
    }

    case "scatter": {
      if (!xField || !yField) {
        return { ok: false, reason: "unknown_field", detail: "scatter needs x/y" };
      }
      const pts = dataset.rows
        .map((r) => [Number(r[xField.name]), Number(r[yField.name])] as [number, number])
        .filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b));
      if (pts.length === 0) {
        return { ok: false, reason: "unknown_field", detail: "no numeric points" };
      }
      const axis = (f: typeof xField) => ({
        type: "value" as const,
        name: f && f.unit ? f.name + " (" + f.unit + ")" : (f?.name ?? ""),
        nameTextStyle: { color: "#737373", fontSize: 10 },
        axisLabel: { color: "#737373", fontSize: 10 },
        axisLine: { lineStyle: { color: "rgba(255,255,255,0.12)" } },
        splitLine: { lineStyle: { color: "rgba(255,255,255,0.06)" } },
      });
      return {
        ok: true,
        option: {
          ...BASE,
          tooltip: { ...(BASE.tooltip as object), trigger: "item" },
          grid: { left: 48, right: 24, top: 40, bottom: 36, containLabel: true },
          xAxis: axis(xField),
          yAxis: axis(yField),
          series: [
            {
              type: "scatter",
              symbolSize: 8,
              itemStyle: { color: "#22d3ee", opacity: 0.72 },
              emphasis: { itemStyle: { opacity: 1 } },
              data: pts,
            },
          ],
        },
      };
    }

    default:
      return { ok: false, reason: "unknown_kind" };
  }
}
