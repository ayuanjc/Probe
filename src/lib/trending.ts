import { hostOf } from "@/lib/text";
import { ensureHistory, dailySeries, MIN_POINTS, type History } from "./heat-history";
import {
  heatScore,
  seriesStats,
  statusFromSeries,
  statusReason,
  todayPercentiles,
  type SeriesStats,
} from "./heat";
import { matchTopicNames, topicType } from "./topic-terms";
import type { HeatStatus } from "./schemas";

/**
 * 热点榜（PRD 2.3）：名次 + 状态。
 *
 * 数据源只有一个 —— Hacker News 近 24 小时的 story。
 * 这不是"全网热点"，是"技术圈此刻在讨论什么"，所以标题里必须是
 * "Hacker News 前沿"，不能写"实时热点"，否则就是在编。
 *
 * 名次来自 articles_24h（多少条在提），状态来自 30 天日序列（今天是不是异常）。
 * 两者缺一不可：只有名次时，用户无法区分「一直都在提」和「今天突然被提」。
 * 序列没攒够（首次构建中）时**不出状态标签**，而不是默认给「平稳期」。
 */

const HN_ENDPOINT = "https://hn.algolia.com/api/v1/search_by_date";
const WINDOW_HOURS = 24;
const MAX_STORIES = 1000;
const FETCH_TIMEOUT_MS = 8_000;
const CACHE_TTL_MS = 10 * 60 * 1000;
/**
 * 基线还在构建时快照只缓存 1 分钟。
 * 否则第一次访问（基线未就绪）那份「没有状态标签」的榜单会被钉住 10 分钟 ——
 * 基线 20 秒就建好了，用户却要等十分钟才看得到状态。
 */
const CACHE_TTL_PENDING_MS = 60 * 1000;
const MAX_TOPICS = 12;
const STORIES_PER_TOPIC = 3;
/**
 * MIN_POINTS 定义在 heat-history（基线也要用它）。
 * 阈值取 2：24 小时内 HN 有 994 条 story，其中 442 条 points 为 0 —— 全是刚发布无人评分的，
 * 只排除"完全没人理"，再高就会把话题榜削到只剩六条。
 */

export type TrendingStory = {
  title: string;
  url: string;
  points: number;
  comments: number;
  createdAt: string;
  host: string;
};

export type TrendingTopic = {
  key: string;
  name: string;
  type: string;
  /** 过去 24 小时提到它的 story 数（按 URL 去重） */
  articles24h: number;
  /** 这些 story 的 points 之和 —— 热度票面值 */
  heat: number;
  /** 最近一条提到的 story 的时间；没有它就算不出衰减 */
  lastSeenAt: string;
  /** 0~1 的归一化热度（公式见 src/lib/heat.ts）；序列不足时缺省 */
  heatScore?: number;
  /** 状态标签；序列不足 14 天时缺省 —— 不猜 */
  status?: HeatStatus;
  /** 近 7 日均值 / 前 30 日均值 */
  r7?: number;
  /** 判据原文，给徽章 tooltip */
  statusNote?: string;
  /**
   * 近 14 天的每日提及条数（升序，最后一天是昨天）。
   * 画火花线用；基线没就绪时缺省 —— 不拿零当数据。
   */
  spark?: number[];
  stories: TrendingStory[];
};

export type TrendingHistoryMeta = {
  /** 序列覆盖天数，0 表示还没有基线 */
  days: number;
  from: string;
  to: string;
  builtAt: string | null;
  /** 基线还在构建/落后：这时状态标签可能缺省 */
  pending: boolean;
};

export type TrendingSnapshot = {
  fetchedAt: string;
  windowHours: number;
  /** 抓到的 story 总数 */
  fetchedStories: number;
  /** 达到 MIN_POINTS、真正参与聚合的条数 */
  consideredStories: number;
  topics: TrendingTopic[];
  history: TrendingHistoryMeta;
  degraded: string[];
};

type HnHit = {
  objectID: string;
  title: string | null;
  url: string | null;
  points: number | null;
  num_comments: number | null;
  created_at_i: number;
};

function toStory(hit: HnHit): TrendingStory | null {
  const title = (hit.title ?? "").trim();
  if (title.length < 8) return null;
  const url = hit.url ?? "https://news.ycombinator.com/item?id=" + hit.objectID;
  return {
    title,
    url,
    points: hit.points ?? 0,
    comments: hit.num_comments ?? 0,
    createdAt: new Date(hit.created_at_i * 1000).toISOString(),
    host: hostOf(url),
  };
}

async function fetchStories(sinceSeconds: number): Promise<{ hits: HnHit[] }> {
  const filter = encodeURIComponent("created_at_i>" + sinceSeconds);
  const url = HN_ENDPOINT + "?tags=story&numericFilters=" + filter + "&hitsPerPage=" + MAX_STORIES;
  const res = await fetch(url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    cache: "no-store",
    headers: { "user-agent": "probe/0.1 (+https://github.com/ayuanjc/Probe)" },
  });
  if (!res.ok) throw new Error("hn http " + res.status);
  const json = (await res.json()) as { hits?: HnHit[] };
  return { hits: json.hits ?? [] };
}

function aggregate(stories: TrendingStory[]): TrendingTopic[] {
  const buckets = new Map<string, TrendingStory[]>();
  for (const story of stories) {
    for (const name of matchTopicNames(story.title)) {
      const bucket = buckets.get(name);
      if (bucket) bucket.push(story);
      else buckets.set(name, [story]);
    }
  }

  const topics: TrendingTopic[] = [];
  for (const [name, bucket] of buckets) {
    // 同一条外链在 24 小时内被重复提交很常见（HN 上同一篇文章会有多条 story、
    // 不同 objectID、URL 一模一样）。不去重的话：列表里同一链接出现两次（React
    // key 冲突），而且"N 条在提"把同一篇稿子数了两遍 —— 那是提交次数，不是报道数。
    // 按 url 收敛，保留 points 最高的那条。
    const sorted = [...bucket].sort((a, b) => b.points - a.points);
    const seenUrl = new Set<string>();
    const unique: TrendingStory[] = [];
    for (const story of sorted) {
      if (seenUrl.has(story.url)) continue;
      seenUrl.add(story.url);
      unique.push(story);
    }
    // 只出现过一条 story 的话题没有"热点"含义，只会把榜单稀释成新闻列表
    if (unique.length < 2) continue;
    const lastSeenAt = unique.reduce((latest, s) => (s.createdAt > latest ? s.createdAt : latest), unique[0].createdAt);
    topics.push({
      key: name,
      name,
      type: topicType(name),
      articles24h: unique.length,
      heat: unique.reduce((sum, s) => sum + s.points, 0),
      lastSeenAt,
      stories: unique.slice(0, STORIES_PER_TOPIC),
    });
  }

  // 主排序用"多少条在提"而非"这些条加起来多少分"：
  // 三条爆款 story（TLS，热度 1068）会盖过十三家在提的实体（谷歌，411），
  // 那不是热度，那是单篇运气。PRD 要的也是 articles_24h 排序。
  topics.sort((a, b) => b.articles24h - a.articles24h || b.heat - a.heat);
  return topics.slice(0, MAX_TOPICS);
}

/**
 * 把日序列接到话题上：状态、r7、归一化热度。
 * 序列不足 14 天的话题不写 status/heatScore —— 缺字段比一个假标签诚实。
 */
function enrich(topics: TrendingTopic[], history: History | null): void {
  if (!history) return;
  const nowMs = Date.now();
  for (const topic of topics) {
    const { counts } = dailySeries(history, topic.name);
    const stats: SeriesStats | null = seriesStats(counts);
    if (!stats) continue;
    const ageHours = Math.max(0, (nowMs - Date.parse(topic.lastSeenAt)) / 3_600_000);
    const pct = todayPercentiles(counts, topic.articles24h);
    const status = statusFromSeries(stats, topic.articles24h);
    topic.status = status;
    topic.r7 = Number(stats.r7.toFixed(2));
    topic.statusNote = statusReason(status, stats, topic.articles24h);
    topic.spark = counts.slice(-14);
    topic.heatScore = heatScore({
      articles24h: topic.articles24h,
      median30d: stats.median30,
      mad30d: stats.mad30,
      magPercentile: pct.mag,
      devPercentile: pct.dev,
      ageHours,
    });
  }
}

/**
 * 名次按 heatScore 排（PRD 2.3 的 score 就是排序依据），而不是 articles_24h。
 * 理由：articles_24h 只说「今天有多少条在提」，说不出「这是不是异常、还新不新鲜」。
 * 一个常年被提的话题永远压住今天刚冒头的话题，那就不是热榜而是活跃度榜。
 * heatScore 缺省（序列不足）的排在后面，用 articles_24h 兜底 —— 总比不显示好。
 */
function rankTopics(topics: TrendingTopic[]): void {
  topics.sort((a, b) => {
    const sa = a.heatScore ?? -1;
    const sb = b.heatScore ?? -1;
    if (sb !== sa) return sb - sa;
    return b.articles24h - a.articles24h || b.heat - a.heat;
  });
}

let cache: { at: number; ttl: number; snapshot: TrendingSnapshot } | null = null;

export async function getTrending(force = false): Promise<TrendingSnapshot> {
  const now = Date.now();
  if (!force && cache && now - cache.at < cache.ttl) return cache.snapshot;

  const degraded: string[] = [];
  const since = Math.floor(now / 1000) - WINDOW_HOURS * 3600;

  let stories: TrendingStory[] = [];
  try {
    const { hits } = await fetchStories(since);
    stories = hits.map(toStory).filter((s): s is TrendingStory => s !== null);
  } catch (err) {
    degraded.push("hn");
    console.warn("[trending] hn failed:", err instanceof Error ? err.message : err);
  }

  // GDELT 是"多少家媒体在报"的唯一来源。这里从未请求过它（未接入），
  // 所以降级说明只写事实：单源。不要说成"出口被限流"——那是编的原因。
  degraded.push("gdelt:not_configured");
  if (stories.length === 0) degraded.push("stories:empty");

  const fetchedStories = stories.length;
  const considered = stories.filter((s) => s.points >= MIN_POINTS);
  const topics = aggregate(considered);
  if (topics.length === 0 && considered.length > 0) degraded.push("topics:empty");

  const historyState = await ensureHistory();
  const history = historyState.history;
  enrich(topics, history);
  rankTopics(topics);
  if (!history) degraded.push("history:building");
  else if (historyState.pending) degraded.push("history:stale");
  if (history && topics.some((t) => t.status === undefined)) degraded.push("history:short_series");

  const historyMeta: TrendingHistoryMeta = {
    days: history?.days.length ?? 0,
    from: history?.from ?? "",
    to: history?.to ?? "",
    builtAt: history?.builtAt ?? null,
    pending: historyState.pending || !history,
  };

  const snapshot: TrendingSnapshot = {
    fetchedAt: new Date(now).toISOString(),
    windowHours: WINDOW_HOURS,
    fetchedStories,
    consideredStories: considered.length,
    topics,
    history: historyMeta,
    degraded,
  };

  const baselineReady = Boolean(history) && !historyState.pending;
  cache = { at: now, ttl: baselineReady ? CACHE_TTL_MS : CACHE_TTL_PENDING_MS, snapshot };
  return snapshot;
}
