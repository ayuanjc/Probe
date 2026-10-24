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

/**
 * 日期只接受 YYYY-MM-DD，且必须是真实存在的日历日。
 * 以前这里只写 z.string()，于是模型吐出 "2026-13-45" 或 "最近三个月" 这种字符串也过审，
 * 一路拼进 GDELT 的时间过滤条件 —— 上游报错被当成限流，还会连带冷却五分钟。
 */
const DayString = z
  .string()
  // 规则路径给的是完整 ISO 时间戳，模型给的多半是 YYYY-MM-DD，两种都要收。
  .regex(/^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/, "日期必须是 YYYY-MM-DD 或 ISO 时间戳")
  .refine((s) => {
    if (Number.isNaN(Date.parse(s))) return false;
    // 格式对但日子不存在（2026-13-45）时 Date 会静默滚到下个月，所以自己核一遍日历。
    const [y, m, d] = s.slice(0, 10).split("-").map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
  }, "日期不存在");

export const IntentSchema = z.object({
  query: z.string().min(1),
  kind: IntentKind,
  entities: z.array(EntitySchema).max(8),
  timeRange: z
    .object({ from: DayString, to: DayString })
    .refine((r) => Date.parse(r.from) <= Date.parse(r.to), { message: "from 不能晚于 to" }),
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
 * ClaimKind — 断言类型（取值表、权重与分类优先序见 src/lib/claim-kind.ts）
 * ------------------------------------------------------------------ */

/**
 * 七类。前四类可核（进判定并按权重计入），后三类不可核（只进「可核验率」分母）。
 *
 * 这里是类型的唯一来源；权重表在 src/lib/claim-kind.ts 声明为 Record<ClaimKind, number>，
 * 少写一个 kind 的权重会直接编译不过，而不是运行时静默按 0 算。
 */
export const ClaimKindSchema = z.enum([
  "quantitative",
  "temporal",
  "attribution",
  "existence",
  "causal",
  "opinion",
  "prediction",
]);
export type ClaimKind = z.infer<typeof ClaimKindSchema>;

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
  /**
   * 断言类型，决定这条断言进不进判定、按多重计。
   *
   * 模型没给就按 existence（0.8）处理 —— 判错的代价两边不对称：
   * 误判成可核只是多一次检索（判定器会返回中性，不进分母）；
   * 误判成不可核则是把一个本来能核的说法永久踢出统计，而且用户看不见。
   */
  kind: ClaimKindSchema.default("existence"),
});
export type Claim = z.infer<typeof ClaimSchema>;

/* ------------------------------------------------------------------ *
 * Verdict — 断言核验的三态（分析文档 §2）
 * ------------------------------------------------------------------ */

/**
 * support / contradict / neutral 三态，不是布尔。
 *
 * 「没找到证据」必须与「证据说不是」分开：前者是覆盖率问题，后者才是事实问题。
 * 合成两值的话，冷门但正确的断言会被判成有争议，而被大量内容农场包围的错误断言
 * 反倒显得被支持 —— 沉默螺旋（Noelle-Neumann 1974）的界面版本，只是受害者换成了数据。
 *
 * 名字用 neutral 而不是 silent：界面上的第四态「不可核验」由 claim.kind 判定，
 * 不由 verdict 判定 —— 因果/观点/预测类断言拿到的是 neutral，但它们从来不进分母，
 * 与「检索过但没找到」的 neutral 在统计口径上不是一回事。
 */
export const VerdictSchema = z.enum(["support", "contradict", "neutral"]);
export type Verdict = z.infer<typeof VerdictSchema>;

export const ClaimVerdictSchema = z.object({
  /** 断言在核验批次里的下标：结果按位置回填，不靠对象引用。 */
  claimIndex: z.number().int().min(0),
  verdict: VerdictSchema,
  /** 一句话理由，出现在徽章的展开区，替代一个裸分数。 */
  reason: z.string().default(""),
  /** 支撑判定的证据 id。必须来自留出集，不能是文档自己引用过的那批。 */
  evidenceIds: z.array(z.string()).default([]),
});
export type ClaimVerdict = z.infer<typeof ClaimVerdictSchema>;

/** 判定器（模型）对单条断言的输出形状。 */
export const JudgeOutputSchema = z.object({
  verdict: VerdictSchema,
  reason: z.string().default(""),
  /** 与断言相符或相斥的那一句原文；neutral 时留空。 */
  quote: z.string().default(""),
});
export type JudgeOutput = z.infer<typeof JudgeOutputSchema>;

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
