import type { Confidence } from "./schemas";

/**
 * 运行时指标（PRD 附录 B「可观测性」）：每一步的耗时、token、失败原因、降级次数、
 * 独立源数、置信度分布。没有这些数，调优只能靠手感。
 *
 * 三个刻意的边界：
 *   1. 只在本进程内存里，环形覆盖 200 条 —— 这不是监控系统，是「刚才那几轮发生了什么」。
 *      重启即清空，UI 必须自己说清这一点，不能让人当成长期趋势。
 *   2. 不落盘、不写日志：查询词是用户输入，落盘就等于建了个搜索历史库。
 *   3. 查询词默认脱敏，只有配置了 PROBE_METRICS_KEY 且请求头对得上才显示。
 */

export type StageName = "route" | "retrieve" | "analyze" | "compose" | "summary";

export const STAGE_LABEL: Record<StageName, string> = {
  route: "意图",
  retrieve: "检索",
  analyze: "分析",
  compose: "编排",
  summary: "摘要",
};

/** 一次模型调用的用量。字符数一定准；token 只在 SDK 真的给出 usage 时才有。 */
export type UsageDelta = {
  kind: "structured" | "summary";
  promptChars: number;
  outputChars: number;
  tokensIn?: number;
  tokensOut?: number;
};

export type UsageSink = (d: UsageDelta) => void;

export type RunUsage = {
  calls: number;
  structured: number;
  summary: number;
  promptChars: number;
  outputChars: number;
  tokensIn: number;
  tokensOut: number;
/** 有几轮调用真的带回了 usage —— 用来区分「0 token」和「没拿到」。 */
  measured: number;
};

export type RunRecord = {
  id: string;
  at: number;
  /** 存原文，出参时再脱敏：脱敏是展示策略，不该污染存储。 */
  query: string;
  stages: Partial<Record<StageName, number>>;
  totalMs: number;
  sources: number;
  owners: number;
  confidence: number;
  band: Confidence["band"] | "none";
  modules: number;
  moduleErrors: number;
  degraded: string[];
  notes: number;
  demoOnly: boolean;
  llm: boolean;
  model: string | null;
  aborted: boolean;
  usage: RunUsage;
};

export type RunView = Omit<RunRecord, "query"> & { query: string; queryRedacted: boolean };

export type MetricsSnapshot = {
  at: number;
  /** 本轮进程累计记录数（环形缓冲可能已覆盖早期记录）。 */
  total: number;
  kept: number;
  cap: number;
  latency: { p50: number; p95: number; max: number };
  stages: Array<{ stage: StageName; n: number; p50: number; p95: number }>;
  confidence: { low: number; medium: number; high: number; none: number; avg: number };
  degraded: Array<{ code: string; count: number }>;
  usage: RunUsage;
  flags: { aborted: number; demoOnly: number; withErrors: number };
  runs: RunView[];
};

const CAP = 200;
const runs: RunRecord[] = [];
let totalRuns = 0;
let seq = 0;

function emptyUsage(): RunUsage {
  return { calls: 0, structured: 0, summary: 0, promptChars: 0, outputChars: 0, tokensIn: 0, tokensOut: 0, measured: 0 };
}

export function startRun(query: string): RunRecord {
  seq += 1;
  return {
    id: "r" + seq,
    at: Date.now(),
    query,
    stages: {},
    totalMs: 0,
    sources: 0,
    owners: 0,
    confidence: 0,
    band: "none",
    modules: 0,
    moduleErrors: 0,
    degraded: [],
    notes: 0,
    demoOnly: false,
    llm: false,
    model: null,
    aborted: false,
    usage: emptyUsage(),
  };
}

/** 收尾入环。同一条记录重复收尾不会产生两条。 */
export function endRun(run: RunRecord): void {
  if (runs.some((r) => r.id === run.id)) return;
  totalRuns += 1;
  runs.push(run);
  if (runs.length > CAP) runs.splice(0, runs.length - CAP);
}

/** 给 llm 层用的用量收集器：一条记录一个，不要做成全局累加。 */
export function usageSink(run: RunRecord): UsageSink {
  return (d) => {
    run.usage.calls += 1;
    run.usage[d.kind] += 1;
    run.usage.promptChars += d.promptChars;
    run.usage.outputChars += d.outputChars;
    if (typeof d.tokensIn === "number" || typeof d.tokensOut === "number") {
      run.usage.measured += 1;
      run.usage.tokensIn += d.tokensIn ?? 0;
      run.usage.tokensOut += d.tokensOut ?? 0;
    }
  };
}

/** 最近一轮的编号，便于日志/测试对齐。 */
export function lastRunId(): string | null {
  return runs.length > 0 ? runs[runs.length - 1].id : null;
}

export function resetMetrics(): void {
  runs.length = 0;
  totalRuns = 0;
  seq = 0;
}

function percentile(values: number[], q: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return Math.round(sorted[idx]);
}

/** 查询词脱敏：保留长度（排查「长查询是否更慢」用得上），不保留内容。 */
function view(run: RunRecord, reveal: boolean): RunView {
  const { query, ...rest } = run;
  return {
    ...rest,
    query: reveal ? query : "«已脱敏 · " + Array.from(query).length + " 字»",
    queryRedacted: !reveal,
  };
}

export function snapshotMetrics(opts: { revealQueries?: boolean } = {}): MetricsSnapshot {
  const reveal = opts.revealQueries === true;
  const totals = runs.map((r) => r.totalMs);
  const stages: MetricsSnapshot["stages"] = [];
  const names: StageName[] = ["route", "retrieve", "analyze", "compose", "summary"];
  for (const stage of names) {
    const vals = runs.map((r) => r.stages[stage]).filter((v): v is number => typeof v === "number");
    if (vals.length === 0) continue;
    stages.push({ stage, n: vals.length, p50: percentile(vals, 0.5), p95: percentile(vals, 0.95) });
  }

  const conf = { low: 0, medium: 0, high: 0, none: 0, avg: 0 };
  let confSum = 0;
  let confN = 0;
  for (const r of runs) {
    if (r.band === "none") conf.none += 1;
    else {
      conf[r.band as "low" | "medium" | "high"] += 1;
      confSum += r.confidence;
      confN += 1;
    }
  }
  conf.avg = confN === 0 ? 0 : Number((confSum / confN).toFixed(4));

  const degradeCount = new Map<string, number>();
  for (const r of runs) for (const code of r.degraded) degradeCount.set(code, (degradeCount.get(code) ?? 0) + 1);
  const degraded = [...degradeCount.entries()]
    .map(([code, count]) => ({ code, count }))
    .sort((a, b) => b.count - a.count || a.code.localeCompare(b.code));

  const usage = emptyUsage();
  for (const r of runs) {
    usage.calls += r.usage.calls;
    usage.structured += r.usage.structured;
    usage.summary += r.usage.summary;
    usage.promptChars += r.usage.promptChars;
    usage.outputChars += r.usage.outputChars;
    usage.tokensIn += r.usage.tokensIn;
    usage.tokensOut += r.usage.tokensOut;
    usage.measured += r.usage.measured;
  }

  return {
    at: Date.now(),
    total: totalRuns,
    kept: runs.length,
    cap: CAP,
    latency: {
      p50: percentile(totals, 0.5),
      p95: percentile(totals, 0.95),
      max: totals.length === 0 ? 0 : Math.max(...totals),
    },
    stages,
    confidence: conf,
    degraded,
    usage,
    flags: {
      aborted: runs.filter((r) => r.aborted).length,
      demoOnly: runs.filter((r) => r.demoOnly).length,
      withErrors: runs.filter((r) => r.moduleErrors > 0).length,
    },
    runs: runs.slice(-40).reverse().map((r) => view(r, reveal)),
  };
}