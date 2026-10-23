import type { Field, ModuleSpec } from "./schemas";
import { DEFAULT_KIND, FALLBACK_ORDER, KIND_ZH, autoEncode } from "./module-catalog";

/**
 * 「一句话生成模块」（PRD 2.5）。
 *
 * 用户只能拿到这件事的一半：他说"用条形图看每天的文章数"，而这轮到底有哪几份
 * 数据集、每份有哪些字段，是流水线刚算出来的，只有服务端知道。所以请求里带
 * 数据集清单（id / 名称 / 字段 / 前几行样例），回复里只带一个 ModuleSpec。
 *
 * 两条产出路径：
 *   1. 有模型 key：让模型在清单里选数据集 + 图形 + 标题，encode 依然由
 *      autoEncode 按字段类型填 —— 模型不碰坐标映射，也就没有它编造字段的机会。
 *   2. 没有 key 或模型失败：关键词规则。至少让功能在零配置下可用，
 *      这与项目其它部分（fixture 摘要、本地演示样本）的取舍一致。
 */

export type DatasetMeta = {
  id: string;
  name: string;
  unit?: string;
  fields: Field[];
  /** 前几行样例。只用来让模型看懂字段含义，不参与校验。 */
  sample: Record<string, string | number | null>[];
};

export type ModulePlanOk = {
  ok: true;
  spec: ModuleSpec;
  engine: "llm" | "rule";
  /** 为什么选了这份数据与这个图形，界面上如实显示。 */
  reason: string;
};

export type ModulePlanErr = {
  ok: false;
  error: "bad_request" | "no_dataset" | "incompatible";
  message: string;
};

export type ModulePlanReply = ModulePlanOk | ModulePlanErr;

type Kind = ModuleSpec["kind"];

/** 图形关键词。顺序有意义：先匹配更具体的写法（"热力图" 不能被 "图" 吃掉）。 */
const KIND_WORDS: Array<[Kind, string[]]> = [
  ["heatmap", ["热力图", "热图", "热区", "heatmap"]],
  ["treemap", ["矩形树图", "树图", "矩形块", "treemap"]],
  ["scatter", ["散点", "相关性", "scatter"]],
  ["radar", ["雷达", "radar"]],
  ["graph", ["关系图", "网络图", "共现", "graph"]],
  ["funnel", ["漏斗", "funnel"]],
  ["gauge", ["仪表盘", "仪表", "gauge"]],
  ["pie", ["饼图", "占比", "比例", "份额", "构成", "pie"]],
  ["line", ["折线", "趋势", "走势", "时间线", "line"]],
  ["bar", ["条形", "柱状", "柱形", "排行", "排名", "对比", "bar"]],
  ["map", ["地图", "地域", "map"]],
  ["table", ["表格", "明细", "原始列表", "table"]],
  ["kpi", ["指标卡", "指标", "概况", "总览", "概览", "kpi"]],
];

/**
 * 数据集关键词。数据集 id 是流水线内部的稳定标识，这里给每个 id 配一组
 * 中文说法 —— 用户不会说"ds-hours"，他会说"发布时段"。
 */
const DS_WORDS: Record<string, string[]> = {
  "ds-timeline": ["趋势", "时间线", "按天", "每天", "每日", "走势", "日更", "timeline", "daily"],
  "ds-owners": ["信源", "稿源", "来源", "媒体", "ownership", "owner", "source"],
  "ds-tone": ["情感", "情绪", "正负", "正面", "负面", "sentiment", "tone"],
  "ds-hours": ["时段", "小时", "几点", "钟点", "发布时段", "hour"],
  "ds-weekday": ["星期", "周几", "周末", "weekday"],
  "ds-terms": ["专名", "共现", "实体关系", "同现", "term", "entity"],
  "ds-flow": ["漏斗", "收敛", "筛选", "过滤", "funnel"],
  "ds-fresh": ["新鲜", "时效", "24 小时", "24小时", "fresh"],
  "ds-tone-scatter": ["散点", "时距", "scatter"],
  "ds-summary": ["概况", "总览", "概览", "汇总", "总体", "summary"],
};

function scoreDataset(text: string, ds: DatasetMeta): number {
  let score = 0;
  for (const w of DS_WORDS[ds.id] ?? []) if (text.includes(w.toLowerCase())) score += 3;
  if (ds.name && text.includes(ds.name.toLowerCase())) score += 4;
  for (const f of ds.fields) if (text.includes(f.name.toLowerCase())) score += 1;
  return score;
}

function specOf(
  ds: DatasetMeta,
  kind: Kind,
  encode: Record<string, string>,
  title: string,
  note: string,
): ModuleSpec {
  return { id: "m-custom", kind, title: title.slice(0, 40), dataset: ds.id, encode, note };
}

/**
 * 关键词规则：不依赖任何外部服务，零配置下也能用。
 * 匹配不到就明确说匹配不到 —— 猜一个图形比拒绝更糟。
 */
export function rulePlan(instruction: string, datasets: DatasetMeta[]): ModulePlanReply {
  const text = instruction.trim().toLowerCase().slice(0, 200);
  if (!text) return { ok: false, error: "bad_request", message: "先写一句想看的图表，例如「用条形图看每天的文章数」。" };
  if (datasets.length === 0) {
    return { ok: false, error: "no_dataset", message: "这一轮没有可用的数据集：先跑一次检索，面板出来之后再来加。" };
  }

  const wantKind = KIND_WORDS.find(([, words]) => words.some((w) => text.includes(w)))?.[0] ?? null;

  let best: { ds: DatasetMeta; score: number } | null = null;
  for (const ds of datasets) {
    const score = scoreDataset(text, ds);
    if (!best || score > best.score) best = { ds, score };
  }

  // 只说了图形、没说数据：按图形反推最自然的那份数据集。
  if ((!best || best.score === 0) && wantKind) {
    const cand = datasets.find((d) => DEFAULT_KIND[d.id] === wantKind);
    if (cand) best = { ds: cand, score: 0 };
  }

  if (!best || best.score === 0) {
    const names = datasets.map((d) => "「" + d.name + "」").join("、");
    return {
      ok: false,
      error: "no_dataset",
      message:
        "没看出你想看哪一份数据。这一轮有：" + names + "。可以说「用" +
        (wantKind ? KIND_ZH[wantKind] : "条形图") + "看" +
        (datasets[0]?.name ?? "信源") + "」。",
    };
  }

  const ds = best.ds;
  const wanted = wantKind ? autoEncode(wantKind, ds.fields) : null;

  if (wantKind && wanted) {
    return {
      ok: true,
      engine: "rule",
      spec: specOf(
        ds,
        wantKind,
        wanted,
        KIND_ZH[wantKind] + " · " + ds.name,
        "按关键词规则生成：图形取自你提到的说法，字段按类型自动匹配。",
      ),
      reason: "关键词命中了「" + ds.name + "」与「" + KIND_ZH[wantKind] + "」。",
    };
  }

  const fallback = DEFAULT_KIND[ds.id] ?? null;
  const order: Kind[] = fallback ? [fallback, ...FALLBACK_ORDER] : FALLBACK_ORDER;
  for (const kind of order) {
    const encode = autoEncode(kind, ds.fields);
    if (!encode) continue;
    const note =
      wantKind && kind !== wantKind
        ? "「" + ds.name + "」的字段画不出" + KIND_ZH[wantKind] + "，已改用" + KIND_ZH[kind] + "。"
        : "按关键词规则生成：字段按类型自动匹配。";
    return {
      ok: true,
      engine: "rule",
      spec: specOf(ds, kind, encode, KIND_ZH[kind] + " · " + ds.name, note),
      reason: "关键词命中了「" + ds.name + "」，图形按字段结构选了" + KIND_ZH[kind] + "。",
    };
  }

  return { ok: false, error: "incompatible", message: "「" + ds.name + "」的字段画不出任何已注册的图形。" };
}

/** 模型在清单里选出来的方案，还要回到注册表验一遍。 */
export type LlmPick = {
  dataset: string;
  kind: Kind;
  title: string;
  reason?: string;
};

export function specFromPick(
  pick: LlmPick,
  datasets: DatasetMeta[],
): ModulePlanReply {
  const ds = datasets.find((d) => d.id === pick.dataset);
  if (!ds) return { ok: false, error: "no_dataset", message: "模型选了一份不存在的数据集：'" + pick.dataset + "'。" };
  const encode = autoEncode(pick.kind, ds.fields);
  if (!encode) {
    return {
      ok: false,
      error: "incompatible",
      message: "「" + ds.name + "」的字段画不出" + (KIND_ZH[pick.kind] ?? pick.kind) + "。",
    };
  }
  return {
    ok: true,
    engine: "llm",
    spec: specOf(ds, pick.kind, encode, pick.title, pick.reason ?? "由模型在已有数据集里挑选，字段映射仍由注册表决定。"),
    reason: pick.reason ?? "模型选了「" + ds.name + "」+「" + KIND_ZH[pick.kind] + "」。",
  };
}

/** 给模型看的清单。字段类型要写明，否则它会把数值字段当分类轴。 */
export function describeDatasets(datasets: DatasetMeta[]): string {
  return datasets
    .map((ds) => {
      const fields = ds.fields.map((f) => f.name + "(" + f.type + (f.unit ? "," + f.unit : "") + ")").join(" / ");
      const sample = ds.sample.length > 0 ? JSON.stringify(ds.sample.slice(0, 3)) : "（无）";
      return "- " + ds.id + "「" + ds.name + "」字段：" + fields + "；样例：" + sample;
    })
    .join("\n");
}
