import { ALIASES } from "@/lib/entities";
import { hostOf } from "@/lib/text";

/**
 * 热点榜 v0（PRD Phase 2）：静态 Top N，按热度排序，不做状态标签。
 *
 * 数据源只有一个 —— Hacker News 近 24 小时的 story。
 * 这不是"全网热点"，是"技术圈此刻在讨论什么"，所以标题里必须是
 * "Hacker News 前沿"，不能写"实时热点"，否则就是在编。
 *
 * GDELT 本该是这里的主力（它的 articles_24h 才是"多少家媒体在报"），
 * 但当前出口 IP 长期 429，所以 v0 只用 HN，并在 degraded 里如实标明。
 */

const HN_ENDPOINT = "https://hn.algolia.com/api/v1/search_by_date";
const WINDOW_HOURS = 24;
const MAX_STORIES = 1000;
const FETCH_TIMEOUT_MS = 8_000;
const CACHE_TTL_MS = 10 * 60 * 1000;
const MAX_TOPICS = 12;
const STORIES_PER_TOPIC = 3;
/**
 * 一条没人看的 story 提到某词，不构成"这个词热"，只构成"这个词出现过"。
 * 24 小时内 HN 有 994 条 story，其中 442 条 points 为 0 —— 全是刚发布无人评分的。
 * 阈值取 2：只排除"完全没人理"，保留 558 条，再高就会把话题榜削到只剩六条。
 */
const MIN_POINTS = 2;

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
  /** 过去 24 小时提到它的 story 数 */
  articles24h: number;
  /** 这些 story 的 points 之和 —— 排序依据 */
  heat: number;
  stories: TrendingStory[];
};

export type TrendingSnapshot = {
  fetchedAt: string;
  windowHours: number;
  /** 抓到的 story 总数 */
  fetchedStories: number;
  /** 达到 MIN_POINTS、真正参与聚合的条数 */
  consideredStories: number;
  topics: TrendingTopic[];
  degraded: string[];
};

type Term = { match: RegExp; name: string; type: string };

/**
 * 词典里的实体直接复用，展示名取中文。
 * 只按词边界匹配英文名：HN 标题以英文为主，中文别名在这里没有命中率。
 */
const ENTITY_TERMS: Term[] = ALIASES.map((a) => {
  // zh[0] 不一定是中文（openai / amd / asml 这些别名本身就是英文小写），
  // 直接拿去展示会变成榜上写着 "openai"。有中文用中文，没有用规范英文名。
  const firstZh = a.zh[0];
  const name = /[\u4e00-\u9fa5]/.test(firstZh) ? firstZh : a.en;
  return {
    match: new RegExp("\\b" + a.en.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b", "i"),
    name,
    type: a.type,
  };
});

/**
 * 词典覆盖不到的部分：HN 的日常话题以技术名词为主，
 * 这些不是公司也不是机构，但确实是"此刻在讨论什么"。
 */
const TECH_TERMS: { kw: string; name: string }[] = [
  { kw: "artificial intelligence", name: "人工智能" },
  { kw: "AI", name: "人工智能" },
  { kw: "LLM", name: "大语言模型" },
  { kw: "Rust", name: "Rust" },
  { kw: "Python", name: "Python" },
  { kw: "JavaScript", name: "JavaScript" },
  { kw: "TypeScript", name: "TypeScript" },
  // "Go" 不进来：英文里 Go 是常用动词，会把 "When Korean Ships Go Dark"
  // 算成 Go 语言的讨论。这类词在标题上没有可用边界，宁可漏掉。
  { kw: "Zig", name: "Zig" },
  { kw: "Kubernetes", name: "Kubernetes" },
  { kw: "Docker", name: "Docker" },
  { kw: "Linux", name: "Linux" },
  { kw: "PostgreSQL", name: "PostgreSQL" },
  { kw: "SQLite", name: "SQLite" },
  { kw: "WebAssembly", name: "WebAssembly" },
  { kw: "encryption", name: "加密" },
  { kw: "privacy", name: "隐私" },
  { kw: "security", name: "安全" },
  { kw: "DNS", name: "DNS" },
  { kw: "TLS", name: "TLS" },
  { kw: "AWS", name: "AWS" },
  { kw: "Cloudflare", name: "Cloudflare" },
  { kw: "Chrome", name: "Chrome" },
  { kw: "Firefox", name: "Firefox" },
  { kw: "Android", name: "Android" },
  { kw: "iOS", name: "iOS" },
  { kw: "EU", name: "欧盟" },
];

const TECH_TERMS_READY: Term[] = TECH_TERMS.map((t) => ({
  match: new RegExp("\\b" + t.kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b", "i"),
  name: t.name,
  type: "tech",
}));

/** 词典优先：同一段文本里 NVIDIA 命中后，不再被 TECH_TERMS 的泛词重复计一次。 */
const ALL_TERMS: Term[] = [...ENTITY_TERMS, ...TECH_TERMS_READY];

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
  const buckets = new Map<string, { term: Term; stories: TrendingStory[] }>();

  for (const story of stories) {
    const matched = new Set<string>();
    for (const term of ALL_TERMS) {
      if (matched.has(term.name)) continue;
      if (!term.match.test(story.title)) continue;
      matched.add(term.name);
      const bucket = buckets.get(term.name);
      if (bucket) bucket.stories.push(story);
      else buckets.set(term.name, { term, stories: [story] });
    }
  }

  const topics: TrendingTopic[] = [];
  for (const [name, bucket] of buckets) {
    // 同一条外链在 24 小时内被重复提交很常见（HN 上同一篇文章会有多条 story、
    // 不同 objectID、URL 一模一样）。不去重的话：列表里同一链接出现两次（React
    // key 冲突），而且"N 条在提"把同一篇稿子数了两遍 —— 那是提交次数，不是报道数。
    // 按 url 收敛，保留 points 最高的那条。
    const sorted = [...bucket.stories].sort((a, b) => b.points - a.points);
    const seenUrl = new Set<string>();
    const unique: TrendingStory[] = [];
    for (const story of sorted) {
      if (seenUrl.has(story.url)) continue;
      seenUrl.add(story.url);
      unique.push(story);
    }
    // 只出现过一条 story 的话题没有"热点"含义，只会把榜单稀释成新闻列表
    if (unique.length < 2) continue;
    topics.push({
      key: name,
      name,
      type: bucket.term.type,
      articles24h: unique.length,
      heat: unique.reduce((sum, s) => sum + s.points, 0),
      stories: unique.slice(0, STORIES_PER_TOPIC),
    });
  }

  // 主排序用"多少条在提"而非"这些条加起来多少分"：
  // 三条爆款 story（TLS，热度 1068）会盖过十三家在提的实体（谷歌，411），
  // 那不是热度，那是单篇运气。PRD 要的也是 articles_24h 排序。
  topics.sort((a, b) => b.articles24h - a.articles24h || b.heat - a.heat);
  return topics.slice(0, MAX_TOPICS);
}

let cache: { at: number; snapshot: TrendingSnapshot } | null = null;

export async function getTrending(force = false): Promise<TrendingSnapshot> {
  const now = Date.now();
  if (!force && cache && now - cache.at < CACHE_TTL_MS) return cache.snapshot;

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

  // GDELT 是"多少家媒体在报"的唯一来源，它缺席时榜单语义要降级说明
  degraded.push("gdelt");

  if (stories.length === 0) degraded.push("stories:empty");

  const fetchedStories = stories.length;
  const considered = stories.filter((s) => s.points >= MIN_POINTS);

  const topics = aggregate(considered);
  if (topics.length === 0 && considered.length > 0) degraded.push("topics:empty");

  const snapshot: TrendingSnapshot = {
    fetchedAt: new Date(now).toISOString(),
    windowHours: WINDOW_HOURS,
    fetchedStories,
    consideredStories: considered.length,
    topics,
    degraded,
  };

  cache = { at: now, snapshot };
  return snapshot;
}
