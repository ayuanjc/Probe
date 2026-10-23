import { z } from "zod";

/* ------------------------------------------------------------------ *
 * Intent — Router 的输出（PRD 2.1）
 * ------------------------------------------------------------------ */

export const IntentKind = z.enum(["lookup", "exploratory", "no-panel"]);
export const Dimension = z.enum([
  "trend",
  "distribution",
  "geo",
  "sentiment",
  "timeline",
  "kpi",
]);
export const EntityType = z.enum(["org", "person", "tech", "event", "metric"]);

export const EntitySchema = z.object({
  name: z.string().min(1),
  type: EntityType,
  candidates: z.array(z.string()).optional(),
});

export const IntentSchema = z.object({
  query: z.string().min(1),
  kind: IntentKind,
  entities: z.array(EntitySchema).max(8),
  timeRange: z.object({ from: z.string(), to: z.string() }),
  dimensions: z.array(Dimension).max(6),
  /** 0~1。> 0.35 时前端先渲染澄清卡（PRD 2.1）。 */
  ambiguity: z.number().min(0).max(1),
  language: z.string().default("zh"),
});
export type Intent = z.infer<typeof IntentSchema>;
export type Entity = z.infer<typeof EntitySchema>;

/* ------------------------------------------------------------------ *
 * RawSource — Retriever 的归一化输出（PRD 2.2）
 * ------------------------------------------------------------------ */

export const ProviderName = z.enum(["tavily", "gdelt", "wiki", "hn", "fixture"]);

export const RawSourceSchema = z.object({
  id: z.string(),
  url: z.string(),
  canonical: z.string().optional(),
  domain: z.string(),
  /** 媒体集团 / 稿源归属。独立性判定的单位是 owner，不是域名。 */
  owner: z.string(),
  title: z.string(),
  snippet: z.string().default(""),
  lang: z.string().default("unknown"),
  publishedAt: z.string(),
  /** 仅 GDELT GKG 提供，范围约 -100 ~ +100。 */
  tone: z.number().optional(),
  provider: ProviderName,
});
export type RawSource = z.infer<typeof RawSourceSchema>;

/* ------------------------------------------------------------------ *
 * Claims — 结构化抽取（PRD 2.2：无 quote 的字段一律丢弃）
 * ------------------------------------------------------------------ */

export const ClaimSchema = z.object({
  /** 属性名，如 "revenue" / "launch_date" / "ceo"。 */
  attr: z.string().min(1),
  value: z.string().min(1),
  /** 原文片段。为空则该 claim 被丢弃。 */
  quote: z.string().min(1),
  sourceIds: z.array(z.string()).min(1),
  unit: z.string().optional(),
});
export type Claim = z.infer<typeof ClaimSchema>;

/* ------------------------------------------------------------------ *
 * Dataset — Analyzer 的产物，Compose 只能引用它
 * ------------------------------------------------------------------ */

export const FieldSchema = z.object({
  name: z.string(),
  type: z.enum(["time", "number", "string"]),
  unit: z.string().optional(),
});

export const DatasetSchema = z.object({
  id: z.string(),
  name: z.string(),
  unit: z.string().optional(),
  fields: z.array(FieldSchema),
  rows: z.array(z.record(z.string(), z.union([z.string(), z.number(), z.null()]))),
});
export type Dataset = z.infer<typeof DatasetSchema>;
export type Field = z.infer<typeof FieldSchema>;

/* ------------------------------------------------------------------ *
 * ModuleSpec — Compose 的产物（PRD 2.4：不产出 ECharts option）
 * ------------------------------------------------------------------ */

export const ModuleKind = z.enum([
  "bar",
  "line",
  "pie",
  "treemap",
  "map",
  "table",
  "kpi",
  // 第二批：都是"能从现有原始条目真算出来"的形状，不是装饰。
  "heatmap",
  "radar",
  "graph",
  "funnel",
  "gauge",
  "scatter",
]);

export const ModuleSpecSchema = z.object({
  id: z.string(),
  kind: ModuleKind,
  title: z.string(),
  /** 只能引用已有 dataset 的 id。 */
  dataset: z.string(),
  encode: z.record(z.string(), z.string()).default({}),
  note: z.string().optional(),
});
export type ModuleSpec = z.infer<typeof ModuleSpecSchema>;

/* ------------------------------------------------------------------ *
 * Confidence — 三分量（PRD 2.2）
 * ------------------------------------------------------------------ */

export const ConfidenceSchema = z.object({
  independence: z.number(),
  firstHand: z.number(),
  consistency: z.number(),
  score: z.number(),
  band: z.enum(["high", "medium", "low"]),
  nOwners: z.number(),
  nSyndicated: z.number(),
  nChecked: z.number(),
  nConflicts: z.number(),
});
export type Confidence = z.infer<typeof ConfidenceSchema>;

/* ------------------------------------------------------------------ *
 * Heat — 热点雷达（PRD 2.3）
 * ------------------------------------------------------------------ */

export const HeatStatus = z.enum([
  "burst",
  "rising",
  "stable",
  "decaying",
  "long-tail",
]);
export type HeatStatus = z.infer<typeof HeatStatus>;

export const HeatTopicSchema = z.object({
  topic: z.string(),
  score: z.number(),
  status: HeatStatus,
  controversial: z.boolean(),
  articles24h: z.number(),
  r7: z.number(),
  tone: z.object({ positive: z.number(), neutral: z.number(), negative: z.number() }).optional(),
});
export type HeatTopic = z.infer<typeof HeatTopicSchema>;
