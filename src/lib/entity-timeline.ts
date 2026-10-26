/**
 * 把一堆实体命中折成「事件时间线」，并按来源可信度分叉。
 *
 * 问题：同一个事件会被多个源在几小时内先后报道，标题各不相同（"英伟达 Q3 营收超预期"
 * / "NVIDIA beats estimates as AI demand surges"）。如果平铺成一条列表，读者看到的是
 * 一堆重复；如果去重只留一条，就抹掉了「谁说、多晚、说法一致不一致」这三个最有用的信息。
 *
 * 所以这里做的是**聚类 + 分叉**：
 *   - 标题相似且时间相近（默认 48 小时）的命中归成一个事件；
 *   - 事件里可信度最高的一条是**主干**，其余按档位挂成分支；
 *   - 分支与主干标题差异过大、或档位相差 ≥2 时标「说法不一致 / 档位差」，
 *     提醒读者这条还没被更强的源确认过。
 *
 * 全纯函数：不碰数据库、不看时间以外的状态，方便单测。
 */
import type { EntityHit } from "@/lib/entity-track";
import { sourceTier, TIER_LABELS, type SourceTier } from "@/lib/source-tier";

export type TimelineBranch = {
  /** 分支 id（= 命中的 id，前端做 key 用） */
  id: string;
  title: string;
  url: string;
  host: string | null;
  provider: string | null;
  tier: SourceTier;
  tierLabel: string;
  /** 与主干标题的相似度（0–1），主干自己是 1 */
  similarity: number;
  at: number;
};

export type TimelineEvent = {
  id: string;
  /** 事件时间：主干那条的时间（不是平均值，读者看的是「谁先说的」） */
  at: number;
  /** 最早出现的分支时间：用来显示「比主干早 / 晚多久」 */
  firstAt: number;
  main: TimelineBranch;
  branches: TimelineBranch[];
  /** 出现在这个事件里的档位数 */
  tiers: SourceTier[];
  /** 分支里有没有与主干说法不一致的（相似度 < 0.55） */
  divergent: boolean;
  /** 活跃了几个小时（最后一条 - 最早一条） */
  spanHours: number;
};

export type ClusterOptions = {
  /** 归成同一个事件的最低标题相似度，默认 0.5 */
  threshold?: number;
  /** 时间窗（小时），默认 48 */
  windowHours?: number;
  /** 每个事件最多列几条分支，默认 6 */
  maxBranches?: number;
};

const STOP_TOKENS = new Set([
  "the", "and", "for", "with", "from", "that", "this", "are", "was", "will", "has", "have",
  "says", "said", "new", "after", "over", "into", "its", "his", "her", "their", "you", "our",
  "的", "了", "与", "和", "在", "是", "为", "对", "被", "把", "将", "已", "有", "也", "就", "都", "而",
]);

/**
 * 标题 → token 集合。
 *
 * 中文没有分词器：用 2-gram。英文取长度 ≥3 的词。
 * 数字单独保留（"Q3"、"2026" 这类往往是区分不同事件的关键，"苹果发布 iPhone 17" 与 "16" 不该合并）。
 */
export function titleTokens(title: string): Set<string> {
  const text = String(title ?? "").toLowerCase();
  const tokens = new Set<string>();
  for (const m of text.matchAll(/[a-z0-9]+/g)) {
    const w = m[0];
    if (w.length >= 3 || /^\d+$/.test(w)) tokens.add(w);
  }
  const han = text.replace(/[^\u4e00-\u9fa5]/g, " ");
  for (const seg of han.split(/\s+/)) {
    if (seg.length === 1) continue;
    for (let i = 0; i + 2 <= seg.length; i += 1) tokens.add(seg.slice(i, i + 2));
  }
  for (const s of STOP_TOKENS) tokens.delete(s);
  return tokens;
}

/** Jaccard 相似度。两边都为空时算 0（空标题不该和任何东西合并）。 */
export function similarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const t of small) if (large.has(t)) inter += 1;
  return inter / (a.size + b.size - inter);
}

function branchOf(hit: EntityHit): TimelineBranch {
  const t = sourceTier({ host: hit.host, provider: hit.provider });
  return {
    id: hit.id,
    title: hit.title,
    url: hit.url,
    host: hit.host,
    provider: hit.provider,
    tier: t.tier,
    tierLabel: TIER_LABELS[t.tier],
    similarity: 1,
    at: hit.at,
  };
}

/**
 * 命中 → 事件时间线。
 *
 * 输入按时间倒序（listEntityHits 的输出），输出也按时间倒序：
 * 最新的那个事件在最上面 —— 时间线是给「这几天发生了什么」用的，不是档案馆。
 */
export function buildTimeline(hits: readonly EntityHit[], opts: ClusterOptions = {}): TimelineEvent[] {
  const threshold = opts.threshold ?? 0.5;
  const windowMs = (opts.windowHours ?? 48) * 3_600_000;
  const maxBranches = Math.max(1, Math.floor(opts.maxBranches ?? 6));

  type Cluster = { items: { hit: EntityHit; tokens: Set<string> }[] };
  const clusters: Cluster[] = [];

  for (const hit of hits) {
    const tokens = titleTokens(hit.title);
    let best: { cluster: Cluster; score: number } | null = null;
    for (const cluster of clusters) {
      const head = cluster.items[0];
      // 时间窗：与聚类里第一条（最早）比，避免一条旧闻把整年的标题都吸进来。
      if (Math.abs(head.hit.at - hit.at) > windowMs) continue;
      const score = similarity(tokens, head.tokens);
      if (score < threshold) continue;
      if (!best || score > best.score) best = { cluster, score };
    }
    if (best) best.cluster.items.push({ hit, tokens });
    else clusters.push({ items: [{ hit, tokens }] });
  }

  const events: TimelineEvent[] = clusters.map((cluster) => {
    const items = cluster.items.slice().sort((a, b) => b.hit.at - a.hit.at);
    const branches = items.map((i) => branchOf(i.hit));
    // 主干 = 档位最高（数字最小）的那条；同档取更早的 —— 先说的人更接近源头。
    const sorted = branches.slice().sort((a, b) => (a.tier - b.tier) || (a.at - b.at));
    const main = sorted[0];
    const mainTokens = titleTokens(main.title);
    for (const b of branches) b.similarity = b === main ? 1 : Number(similarity(mainTokens, titleTokens(b.title)).toFixed(2));
    const others = branches
      .filter((b) => b !== main)
      .sort((a, b) => (a.tier - b.tier) || (a.at - b.at))
      .slice(0, maxBranches);
    const tiers = Array.from(new Set(branches.map((b) => b.tier))).sort() as SourceTier[];
    const firstAt = Math.min(...branches.map((b) => b.at));
    const lastAt = Math.max(...branches.map((b) => b.at));
    return {
      id: main.id,
      at: main.at,
      firstAt,
      main,
      branches: others,
      tiers,
      divergent: others.some((b) => b.similarity < 0.55),
      spanHours: Number(((lastAt - firstAt) / 3_600_000).toFixed(1)),
    };
  });

  events.sort((a, b) => b.at - a.at);
  return events;
}
