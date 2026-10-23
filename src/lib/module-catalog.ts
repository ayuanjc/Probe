import type { Field, ModuleSpec } from "./schemas";

/**
 * 模块注册表。
 *
 * PRD 2.4 的边界是：模型只能产出 ModuleSpec，不能直接写 ECharts option。
 * 「一句话生成模块」正好踩在这条线上 —— 用户用自然语言点一份图表，很容易被
 * 理解成"让模型画图"，于是又滑回 option 幻觉。这里把可生成的空间写死成一张
 * 表：13 种图形 × 各自必需的 encode 槽位 × 默认栅格尺寸。模型（或关键词规则）
 * 只能在这张表里选，选完还要过 compile() 白名单才允许上屏。
 */

type Kind = ModuleSpec["kind"];

/** 图形中文名。标题与错误提示都用它，避免界面上出现 bar/pie 这种枚举值。 */
export const KIND_ZH: Record<Kind, string> = {
  bar: "条形图",
  line: "折线图",
  pie: "饼图",
  treemap: "矩形树图",
  map: "地图",
  table: "表格",
  kpi: "指标卡",
  heatmap: "热力图",
  radar: "雷达图",
  graph: "关系图",
  funnel: "漏斗图",
  gauge: "仪表盘",
  scatter: "散点图",
};

/**
 * 默认尺寸的单位是"网格单元"：12 列、行高 28px（见 src/lib/layout.ts）。
 * 这里只给建议值 —— 用户拖过的布局以本机快照为准。
 */
export const MODULE_SIZE: Record<Kind, { w: number; h: number }> = {
  kpi: { w: 12, h: 4 },
  line: { w: 8, h: 8 },
  bar: { w: 4, h: 8 },
  pie: { w: 4, h: 8 },
  treemap: { w: 6, h: 8 },
  map: { w: 8, h: 10 },
  table: { w: 6, h: 8 },
  heatmap: { w: 8, h: 8 },
  radar: { w: 4, h: 8 },
  graph: { w: 6, h: 10 },
  funnel: { w: 4, h: 8 },
  gauge: { w: 4, h: 6 },
  scatter: { w: 6, h: 8 },
};

/** 每种图形需要哪几个字段角色，按顺序填进 encode 的哪个键。 */
type Role = "dim" | "dim2" | "num";

const SLOTS: Record<Kind, { keys: string[]; roles: Role[] }> = {
  bar: { keys: ["x", "y"], roles: ["dim", "num"] },
  line: { keys: ["x", "y"], roles: ["dim", "num"] },
  pie: { keys: ["x", "value"], roles: ["dim", "num"] },
  treemap: { keys: ["x", "value"], roles: ["dim", "num"] },
  map: { keys: ["x", "value"], roles: ["dim", "num"] },
  table: { keys: ["x"], roles: ["dim"] },
  kpi: { keys: ["x", "value"], roles: ["dim", "num"] },
  heatmap: { keys: ["x", "y", "value"], roles: ["dim", "dim2", "num"] },
  radar: { keys: ["x", "value"], roles: ["dim", "num"] },
  graph: { keys: ["x", "y", "value"], roles: ["dim", "dim2", "num"] },
  funnel: { keys: ["x", "value"], roles: ["dim", "num"] },
  gauge: { keys: ["x", "value"], roles: ["dim", "num"] },
  scatter: { keys: ["x", "y"], roles: ["num", "num"] },
};

function pickField(fields: Field[], role: Role, used: Set<string>): string | null {
  const free = fields.filter((f) => !used.has(f.name));
  const byType = (t: Field["type"]) => free.find((f) => f.type === t)?.name ?? null;
  if (role === "dim") return byType("time") ?? byType("string") ?? byType("number");
  // 第二维优先分类字段；热力图的纵轴是"小时"，那种情况允许落到数值字段上。
  if (role === "dim2") return byType("string") ?? byType("number") ?? byType("time");
  return byType("number");
}

/**
 * 按字段类型自动填 encode。返回 null 表示这份数据集根本画不出这种图
 * （例如只有一个数值字段却要散点图的两个轴）—— 拒绝，而不是硬塞一个 0。
 */
export function autoEncode(kind: Kind, fields: Field[]): Record<string, string> | null {
  const slots = SLOTS[kind];
  if (!slots) return null;
  const used = new Set<string>();
  const encode: Record<string, string> = {};
  for (let i = 0; i < slots.keys.length; i++) {
    const name = pickField(fields, slots.roles[i], used);
    if (!name) return null;
    used.add(name);
    encode[slots.keys[i]] = name;
  }
  return encode;
}

/** 各数据集最自然的图形，用于"用户没指定图形"时兜底。 */
export const DEFAULT_KIND: Record<string, Kind> = {
  "ds-timeline": "line",
  "ds-owners": "bar",
  "ds-tone": "pie",
  "ds-summary": "kpi",
  "ds-hours": "heatmap",
  "ds-weekday": "radar",
  "ds-terms": "graph",
  "ds-flow": "funnel",
  "ds-fresh": "gauge",
  "ds-tone-scatter": "scatter",
};

/** 兜底顺序：从最通用的形状开始试，第一个装得下字段的就是它。 */
export const FALLBACK_ORDER: Kind[] = ["bar", "line", "pie", "kpi", "table"];

/**
 * compile 的拒绝原因翻成用户能读懂的一句话。
 * PRD 要求 module.error 可见 —— 拒绝本身没错，静默拒绝才是问题。
 */
const COMPILE_TEXT: Record<string, string> = {
  unknown_kind: "这个图形不在注册表里",
  unknown_dataset: "找不到对应的数据集",
  unknown_field: "字段对不上",
  pie_constraint: "饼图只接受一组正数，且每片都要有标签",
  mixed_units: "两个轴的单位不一致，不能画在一张图上",
  time_order: "时间轴顺序是倒的",
  radar_constraint: "雷达图至少要三个维度",
  funnel_constraint: "漏斗图每一级必须是上一级的子集（只减不增）",
  graph_constraint: "关系图至少需要三条边",
};

export function compileErrorText(reason: string, detail?: string): string {
  const base = COMPILE_TEXT[reason] ?? reason;
  return detail ? base + "（" + detail + "）" : base;
}
