
import { z } from "zod";
import { ClaimSchema } from "@/lib/schemas";
import type { Claim, Confidence, Dataset, Intent, RawSource } from "@/lib/schemas";
import { computeConfidence, findSyndicatedIds, allowsAggregateNumbers } from "@/lib/confidence";
import { generateStructured, llmEnabled } from "@/lib/llm";
import { fixtureClaims } from "@/lib/fixtures";
import { toneBucket } from "@/lib/heat";
import { titleSimilarity } from "@/lib/text";

/**
 * 分析层：去重 → 抽取 → 聚合。三条硬规则：
 *   1. 没有 quote 的 claim 直接丢弃（不可溯源等于没有）；
 *   2. 聚合数字只在 confidence.band !== "low" 时产出；
 *   3. 缺失就是缺失，不补 0 —— rows 里宁可少一行。
 */

export type AnalysisResult = {
  sources: RawSource[];
  syndicatedIds: string[];
  claims: Claim[];
  datasets: Dataset[];
  confidence: Confidence;
  degraded: string[];
  notes: string[];
};

function dedupe(sources: RawSource[]): RawSource[] {
  const seenUrl = new Set<string>();
  const seenTitle: string[] = [];
  const out: RawSource[] = [];

  for (const s of sources) {
    const key = (s.canonical ?? s.url).replace(/[?#].*$/, "").replace(/\/$/, "");
    if (!key) continue;
    if (seenUrl.has(key)) continue;

    // 跨源标题几乎一致 → 视为同一稿件的转载，只保留第一条。
    const dup = seenTitle.some((t) => titleSimilarity(t, s.title) > 0.92);
    if (dup) continue;

    seenUrl.add(key);
    seenTitle.push(s.title);
    out.push(s);
  }
  return out;
}

async function extractClaims(
  intent: Intent,
  sources: RawSource[],
): Promise<{ claims: Claim[]; source: "llm" | "fixture" | "none" }> {
  if (sources.length === 0) return { claims: [], source: "none" };

  if (!llmEnabled()) {
    return { claims: fixtureClaims(sources), source: "fixture" };
  }

  const bundle = sources.slice(0, 12).map((s) => ({
    id: s.id,
    title: s.title,
    snippet: s.snippet.slice(0, 300),
    publishedAt: s.publishedAt,
  }));

  const parsed = await generateStructured<{ claims: Claim[] }>({
    schema: ClaimLike,
    system:
      "从给定材料中抽取可核验的事实断言。规则：" +
      "每个 claim 必须带 quote（原文逐字片段）与 sourceIds（只能是输入里出现过的 id）；" +
      "数字类断言必须带 unit；找不到原文支撑就不要输出该 claim；" +
      "不要推理、不要补充材料里没有的信息。",
    prompt:
      "查询：" + intent.query + "\n材料：\n" + JSON.stringify(bundle, null, 1),
  });

  if (!parsed) return { claims: fixtureClaims(sources), source: "fixture" };

  const validIds = new Set(sources.map((s) => s.id));
  const claims = parsed.claims.filter((c) => {
    if (!c.quote || c.quote.trim().length < 4) return false;
    return c.sourceIds.some((id) => validIds.has(id));
  });

  return { claims, source: "llm" };
}

/** 模型返回 { claims: [...] }，逐项过 ClaimSchema。 */
const ClaimLike = z.object({ claims: z.array(ClaimSchema) });

function dayKey(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "unknown";
  return d.toISOString().slice(0, 10);
}

export async function analyze(intent: Intent, raw: RawSource[]): Promise<AnalysisResult> {
  const notes: string[] = [];
  const degraded: string[] = [];

  const sources = dedupe(raw);
  const syndicatedIds = [...findSyndicatedIds(sources)];
  const { claims, source: claimSource } = await extractClaims(intent, sources);
  if (claimSource === "fixture") degraded.push("claims:fixture");

  const confidence = computeConfidence(sources, claims);
  const allowNumbers = allowsAggregateNumbers(confidence);
  const datasets: Dataset[] = [];

  const countDays = new Map<string, number>();
  for (const s of sources) {
    const k = dayKey(s.publishedAt);
    countDays.set(k, (countDays.get(k) ?? 0) + 1);
  }
  const dayRows = [...countDays.entries()]
    .filter(([k]) => k !== "unknown")
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([day, articles]) => ({ day, articles }));

  if (dayRows.length >= 2) {
    datasets.push({
      id: "ds-timeline",
      name: "按日文章数",
      unit: "篇",
      fields: [
        { name: "day", type: "time" },
        { name: "articles", type: "number", unit: "篇" },
      ],
      rows: dayRows,
    });
  }

  if (allowNumbers) {
    const countOwners = new Map<string, number>();
    for (const s of sources) {
      countOwners.set(s.owner, (countOwners.get(s.owner) ?? 0) + 1);
    }
    const ownerRows = [...countOwners.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([owner, articles]) => ({ owner, articles }));

    if (ownerRows.length >= 2) {
      datasets.push({
        id: "ds-owners",
        name: "信源分布",
        unit: "篇",
        fields: [
          { name: "owner", type: "string" },
          { name: "articles", type: "number", unit: "篇" },
        ],
        rows: ownerRows,
      });
    }

    const tone = { positive: 0, neutral: 0, negative: 0 };
    for (const s of sources) {
      if (typeof s.tone === "number") tone[toneBucket(s.tone)]++;
    }
    const toneRows = Object.entries(tone)
      .filter(([, n]) => n > 0)
      .map(([bucket, articles]) => ({ bucket, articles }));

    if (toneRows.length >= 2 && toneRows.length <= 8) {
      datasets.push({
        id: "ds-tone",
        name: "情感分布",
        unit: "篇",
        fields: [
          { name: "bucket", type: "string" },
          { name: "articles", type: "number", unit: "篇" },
        ],
        rows: toneRows,
      });
    }
  } else {
    notes.push("置信度为低档：已抑制聚合数字与分布图，仅展示可核验的原文列表。");
  }

  datasets.push({
    id: "ds-summary",
    name: "本次检索概况",
    fields: [
      { name: "label", type: "string" },
      { name: "value", type: "number" },
    ],
    rows: [
      { label: "命中条目", value: sources.length },
      { label: "独立信源", value: confidence.nOwners },
      { label: "疑似转载", value: syndicatedIds.length },
      { label: "可核验断言", value: claims.length },
    ],
  });

  notes.push("口径说明：文章数指本次检索命中的条目，不是全网总量。");

  return {
    sources,
    syndicatedIds,
    claims,
    datasets,
    confidence,
    degraded,
    notes,
  };
}
