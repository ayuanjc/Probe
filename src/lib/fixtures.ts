
import type { Claim, RawSource } from "./schemas";

/**
 * 离线 / 无 key 时的确定性样本。所有条目 provider 标记为 "fixture"，
 * UI 会明确显示“示例数据”，不会被误当成真实抓取结果。
 */

export function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

const DOMAINS: { domain: string; owner: string; lang: string; tier: number }[] = [
  { domain: "reuters.com", owner: "thomson-reuters", lang: "en", tier: 1 },
  { domain: "bloomberg.com", owner: "bloomberg", lang: "en", tier: 1 },
  { domain: "36kr.com", owner: "36kr", lang: "zh", tier: 1 },
  { domain: "caixin.com", owner: "caixin", lang: "zh", tier: 1 },
  { domain: "techcrunch.com", owner: "techcrunch", lang: "en", tier: 1 },
  { domain: "news.ycombinator.com", owner: "ycombinator", lang: "en", tier: 2 },
  { domain: "aggregator.example", owner: "aggregator-network", lang: "en", tier: 3 },
];

/** 每条样本用不同句式，否则会被自己的去重逻辑判成互相转载。 */
const TITLE_PATTERNS = [
  "{q}：三季度交付与订单观察",
  "分析师下调{q}目标价，理由指向库存",
  "{q} 发布新一代产品线，定价策略变化",
  "供应链消息：{q} 调整产能排期",
  "监管文件显示{q}相关实体新增备案",
  "{q} 财报电话会实录：管理层回避毛利问题",
  "{q} 相关话题在开发者社区引发讨论",
];

export function fixtureSources(query: string, now = Date.now()): RawSource[] {
  const seed = hash(query);
  const count = 4 + (seed % 4);
  const out: RawSource[] = [];
  for (let i = 0; i < count; i++) {
    const d = DOMAINS[(seed + i * 3) % DOMAINS.length];
    const hoursAgo = (seed + i * 7) % 72;
    out.push({
      id: "fx-" + i,
      url: "https://" + d.domain + "/article/" + (seed % 10000) + "/" + i,
      canonical: i > 0 && d.tier === 3 ? "https://reuters.com/article/" + (seed % 10000) : undefined,
      domain: d.domain,
      owner: d.owner,
      title: TITLE_PATTERNS[i % TITLE_PATTERNS.length].replace("{q}", query),
      snippet: query + " 的样本摘要片段，用于在无凭据环境下打通链路。",
      lang: d.lang,
      publishedAt: new Date(now - hoursAgo * 3_600_000).toISOString(),
      tone: d.tier === 3 ? undefined : ((seed + i * 13) % 40) - 18,
      provider: "fixture",
    });
  }
  return out;
}

export function fixtureClaims(sources: RawSource[]): Claim[] {
  if (sources.length === 0) return [];
  const base = sources[0];
  return [
    {
      attr: "reported_metric",
      value: String(120 + (hash(base.title) % 80)),
      unit: "index",
      kind: "quantitative",
      quote: base.snippet,
      sourceIds: [base.id],
    },
    {
      attr: "reported_metric",
      value: String(118 + (hash(base.title) % 80)),
      unit: "index",
      kind: "quantitative",
      quote: sources[1]?.snippet ?? base.snippet,
      sourceIds: [sources[1]?.id ?? base.id],
    },
  ];
}
