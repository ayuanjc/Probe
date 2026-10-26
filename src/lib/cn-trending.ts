import { hostOf } from "@/lib/text";
import {
  cnHistoryMeta,
  cnSeries,
  readCnHistory,
  type CnHistory,
  type CnHistoryMeta,
} from "./cn-history";
import { heatScore, seriesStats, statusFromSeries, statusReason, todayPercentiles, type SeriesStats } from "./heat";
import { matchTopicNamesZh, topicType } from "./topic-terms";
import type { HeatStatus } from "./schemas";

/**
 * 中文科技前沿（A 阶段）。
 *
 * 与 Hacker News 那条轨**分开**，不是分开展示那么简单，是三件不同：
 *  1. 分布不同。HN 一天 1000 条 story、靠投票排序；这里一天不到 150 条、
 *     是编辑写的新闻，没有投票。所以名次只能用「多少篇在写它」，
 *     而 heat（HN 的 points 之和）在这里没有对应物 —— 硬套就是把阅读量当票数。
 *  2. 基线不同（见 cn-history）。
 *  3. 覆盖不同。两个源都只给「最近 N 条」，没有历史检索接口：IT之家约 13 小时、
 *     少数派按页往回到 24 小时为止。页面必须照实说覆盖了多少小时，
 *     不能写「24 小时」然后端上 13 小时的数据。
 *
 * 一个刻意的沉默：这里**不出**「多少家媒体在报」（那要 GDELT），也不出情绪倾向。
 * 只有名次、状态、和回到原文的链接。
 */

export type CnSourceId = "ithome" | "sspai";

export type CnStory = {
  title: string;
  url: string;
  /** 互动量：IT之家 hitcount / 少数派 view+like+comment。上游给 0 就是 0，不猜。 */
  engagement: number;
  createdAt: string;
  host: string;
  source: CnSourceId;
};

export type CnTopic = {
  key: string;
  name: string;
  type: string;
  articles24h: number;
  engagement: number;
  lastSeenAt: string;
  heatScore?: number;
  status?: HeatStatus;
  r7?: number;
  statusNote?: string;
  spark?: number[];
  stories: CnStory[];
};

export type CnSourceMeta = {
  id: CnSourceId;
  name: string;
  ok: boolean;
  count: number;
  /** 这一源最早一条距现在多少小时 —— 页面照实写「覆盖 ~N 小时」 */
  coveredHours: number;
};

export type CnSnapshot = {
  fetchedAt: string;
  windowHours: number;
  sources: CnSourceMeta[];
  rawStories: number;
  consideredStories: number;
  topics: CnTopic[];
  history: CnHistoryMeta;
  degraded: string[];
};

const WINDOW_HOURS = 24;
const FETCH_TIMEOUT_MS = 8_000;
const CACHE_TTL_MS = 10 * 60 * 1000;
/** 基线没攒够时快照只缓存 1 分钟：否则「刚攒到第 14 天」的状态要等 10 分钟才出现。 */
const CACHE_TTL_PENDING_MS = 60 * 1000;
const MAX_TOPICS = 10;
const STORIES_PER_TOPIC = 3;
const SSPAI_PAGE_LIMIT = 20;
const SSPAI_MAX_PAGES = 5;
const UA = "probe/0.1 (+https://github.com/ayuanjc/Probe)";
/** 与 HN / 国内榜单同一条口径：一次失败就判「源挂了」太脆，给一次机会再说。 */
const RETRY_DELAY_MS = 800;

async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch {
    await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
    return fn();
  }
}

const ITHOME_LIST = "https://api.ithome.com/json/newslist/news";
const ITHOME_RSS = "https://www.ithome.com/rss/";
const SSPAI_LIST = "https://sspai.com/api/v1/article/index/page/get";

export const SOURCE_NAMES: Record<CnSourceId, string> = { ithome: "IT之家", sspai: "少数派" };

/** 中文源开关。默认开，独立于 HN 那条（HN 挂了不影响这里）。 */
export function cnTrendingEnabled(): boolean {
  return process.env.PROBE_CN_TRENDING_SERVER !== "0";
}

function enabledSources(): CnSourceId[] {
  const raw = (process.env.PROBE_CN_TRENDING_SOURCES ?? "ithome,sspai").trim();
  const all: CnSourceId[] = ["ithome", "sspai"];
  if (!raw) return all;
  const wanted = new Set(raw.split(",").map((s) => s.trim().toLowerCase()));
  const picked = all.filter((id) => wanted.has(id));
  return picked.length > 0 ? picked : all;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCharCode(Number(d)))
    .replace(/&amp;/g, "&");
}

/**
 * IT之家接口里的 postdate 是「北京时间但没有时区」（"2026-10-26T09:13:15.287"）。
 * 直接 new Date() 会按**运行机器**的时区解释：服务器是 UTC，那 9 小时前的稿子
 * 会被算成 9 小时后 —— 时间一错，24 小时窗口和衰减因子全废。补 +08:00。
 */
function parseIthomeLocal(s: string): string | null {
  const t = Date.parse(s.replace(" ", "T") + "+08:00");
  if (!Number.isFinite(t)) return null;
  return new Date(t).toISOString();
}

function toIso(v: unknown): string | null {
  if (typeof v === "number" && Number.isFinite(v)) {
    // 少数派是 unix 秒
    const ms = v > 1e12 ? v : v * 1000;
    return new Date(ms).toISOString();
  }
  if (typeof v === "string" && v.trim()) {
    const t = Date.parse(v);
    if (Number.isFinite(t)) return new Date(t).toISOString();
  }
  return null;
}

type IthomeListItem = {
  title?: string;
  url?: string;
  postdate?: string;
  hitcount?: number;
  commentcount?: number;
};

async function fetchIthomeList(): Promise<CnStory[]> {
  const res = await fetch(ITHOME_LIST, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    cache: "no-store",
    headers: { "user-agent": UA },
  });
  if (!res.ok) throw new Error("ithome list http " + res.status);
  const json = (await res.json()) as { newslist?: IthomeListItem[] };
  const out: CnStory[] = [];
  for (const item of json.newslist ?? []) {
    const title = (item.title ?? "").trim();
    const raw = (item.url ?? "").trim();
    if (!title || title.length < 8 || !raw) continue;
    const createdAt = item.postdate ? parseIthomeLocal(item.postdate) : null;
    if (!createdAt) continue;
    const url = raw.startsWith("http") ? raw : "https://www.ithome.com" + (raw.startsWith("/") ? raw : "/" + raw);
    out.push({
      title,
      url,
      engagement: (item.hitcount ?? 0) + (item.commentcount ?? 0),
      createdAt,
      host: hostOf(url),
      source: "ithome",
    });
  }
  return out;
}

/** RSS 只用来把覆盖窗口从 10 小时拉到 13 小时左右（它比接口长），没有互动数。 */
async function fetchIthomeRss(): Promise<CnStory[]> {
  const res = await fetch(ITHOME_RSS, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    cache: "no-store",
    headers: { "user-agent": UA },
  });
  if (!res.ok) throw new Error("ithome rss http " + res.status);
  const xml = await res.text();
  const out: CnStory[] = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const block = m[1] ?? "";
    const title = decodeEntities((block.match(/<title>([\s\S]*?)<\/title>/) ?? [])[1] ?? "").trim();
    const link = ((block.match(/<link>([\s\S]*?)<\/link>/) ?? [])[1] ?? "").trim();
    const pub = ((block.match(/<pubDate>([\s\S]*?)<\/pubDate>/) ?? [])[1] ?? "").trim();
    if (!title || title.length < 8 || !link) continue;
    const createdAt = toIso(pub);
    if (!createdAt) continue;
    out.push({
      title,
      url: link,
      engagement: 0,
      createdAt,
      host: hostOf(link),
      source: "ithome",
    });
  }
  return out;
}

type SspaiItem = {
  id?: number;
  title?: string;
  released_time?: number;
  view_count?: number;
  like_count?: number;
  comment_count?: number;
};

async function fetchSspai(sinceMs: number): Promise<CnStory[]> {
  const out: CnStory[] = [];
  const seen = new Set<number>();
  let offset = 0;
  for (let page = 0; page < SSPAI_MAX_PAGES; page++) {
    const url = SSPAI_LIST + "?limit=" + SSPAI_PAGE_LIMIT + "&offset=" + offset;
    const res = await fetch(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      cache: "no-store",
      headers: { "user-agent": UA },
    });
    if (!res.ok) throw new Error("sspai http " + res.status);
    const json = (await res.json()) as { data?: SspaiItem[] };
    const rows = Array.isArray(json.data) ? json.data : [];
    if (rows.length === 0) break;
    let oldest = Number.POSITIVE_INFINITY;
    for (const item of rows) {
      const id = Number(item.id ?? 0);
      const title = (item.title ?? "").trim();
      const createdAt = toIso(item.released_time ?? null);
      if (createdAt) {
        const ms = Date.parse(createdAt);
        if (Number.isFinite(ms)) oldest = Math.min(oldest, ms);
      }
      if (!id || !title || !createdAt) continue;
      if (seen.has(id)) continue;
      seen.add(id);
      if (Date.parse(createdAt) < sinceMs) continue;
      const link = "https://sspai.com/post/" + id;
      out.push({
        title,
        url: link,
        engagement: (item.view_count ?? 0) + (item.like_count ?? 0) + (item.comment_count ?? 0),
        createdAt,
        host: hostOf(link),
        source: "sspai",
      });
    }
    // 翻页按实际返回条数推进：上游 limit 与真实页大小不一定一致，
    // 固定 +20 会跳过一整页（少一半样本，基线就偏小）。
    offset += rows.length;
    if (Number.isFinite(oldest) && oldest < sinceMs) break;
  }
  return out;
}

function dedupe(stories: CnStory[]): CnStory[] {
  const byUrl = new Map<string, CnStory>();
  for (const s of stories) {
    const prev = byUrl.get(s.url);
    if (!prev) {
      byUrl.set(s.url, s);
      continue;
    }
    // 同一篇既有接口（带互动数）又有 RSS 版本时，保留互动数高的那条。
    if (s.engagement > prev.engagement) byUrl.set(s.url, s);
  }
  return [...byUrl.values()];
}

export type CnFetchResult = {
  stories: CnStory[];
  sources: CnSourceMeta[];
  rawStories: number;
  degraded: string[];
};

/** 抓一轮。导出的目的是给 cron 直接拿去记基线（不让它再从快照里反推）。 */
export async function fetchCnStories(now = Date.now()): Promise<CnFetchResult> {
  const sinceMs = now - WINDOW_HOURS * 3600 * 1000;
  const enabled = enabledSources();
  const degraded: string[] = [];
  const sources: CnSourceMeta[] = [];
  const all: CnStory[] = [];

  if (enabled.includes("ithome")) {
    const [list, rss] = await Promise.all([
      withRetry(fetchIthomeList).catch((err) => {
        degraded.push("ithome:list_failed");
        console.warn("[cn] ithome list failed:", err instanceof Error ? err.message : err);
        return [] as CnStory[];
      }),
      withRetry(fetchIthomeRss).catch((err) => {
        degraded.push("ithome:rss_failed");
        console.warn("[cn] ithome rss failed:", err instanceof Error ? err.message : err);
        return [] as CnStory[];
      }),
    ]);
    const rows = dedupe([...list, ...rss]).filter((s) => Date.parse(s.createdAt) >= sinceMs);
    all.push(...rows);
    sources.push(metaOf("ithome", rows, now));
  }

  if (enabled.includes("sspai")) {
    const rows = await withRetry(() => fetchSspai(sinceMs)).catch((err) => {
      degraded.push("sspai:failed");
      console.warn("[cn] sspai failed:", err instanceof Error ? err.message : err);
      return [] as CnStory[];
    });
    all.push(...rows);
    sources.push(metaOf("sspai", rows, now));
  }

  const stories = dedupe(all);
  if (stories.length === 0) degraded.push("cn:empty");
  return { stories, sources, rawStories: all.length, degraded };
}

function metaOf(id: CnSourceId, rows: CnStory[], now: number): CnSourceMeta {
  let earliest = Number.POSITIVE_INFINITY;
  for (const s of rows) {
    const t = Date.parse(s.createdAt);
    if (Number.isFinite(t)) earliest = Math.min(earliest, t);
  }
  const coveredHours = Number.isFinite(earliest)
    ? Math.max(0, Math.round(((now - earliest) / 3_600_000) * 10) / 10)
    : 0;
  return { id, name: SOURCE_NAMES[id], ok: rows.length > 0, count: rows.length, coveredHours };
}

function aggregate(stories: CnStory[]): CnTopic[] {
  const buckets = new Map<string, CnStory[]>();
  for (const story of stories) {
    for (const name of matchTopicNamesZh(story.title)) {
      const bucket = buckets.get(name);
      if (bucket) bucket.push(story);
      else buckets.set(name, [story]);
    }
  }
  const topics: CnTopic[] = [];
  for (const [name, bucket] of buckets) {
    const sorted = [...bucket].sort((a, b) => b.engagement - a.engagement);
    const unique: CnStory[] = [];
    const seen = new Set<string>();
    for (const s of sorted) {
      if (seen.has(s.url)) continue;
      seen.add(s.url);
      unique.push(s);
    }
    // 只有一条也上：中文源一天不到 150 条，用 HN 的「≥2 条」门槛会把榜削空。
    // 代价是「一条也算」—— 所以名次只是名次，状态标签才是判断，别把它当新闻列表读。
    if (unique.length < 1) continue;
    const lastSeenAt = unique.reduce((latest, s) => (s.createdAt > latest ? s.createdAt : latest), unique[0].createdAt);
    topics.push({
      key: name,
      name,
      type: topicType(name),
      articles24h: unique.length,
      engagement: unique.reduce((sum, s) => sum + s.engagement, 0),
      lastSeenAt,
      stories: unique.slice(0, STORIES_PER_TOPIC),
    });
  }
  topics.sort((a, b) => b.articles24h - a.articles24h || b.engagement - a.engagement);
  return topics.slice(0, MAX_TOPICS);
}

/** 序列够 14 天才写状态；不够就只留名次 —— 缺字段比假标签诚实（与 HN 那条同一原则）。 */
function enrich(topics: CnTopic[], history: CnHistory | null, now: number): void {
  if (!history || history.days.length === 0) return;
  for (const topic of topics) {
    const counts = cnSeries(history, topic.name, 14, now);
    const stats: SeriesStats | null = seriesStats(counts);
    if (!stats) continue;
    const ageHours = Math.max(0, (now - Date.parse(topic.lastSeenAt)) / 3_600_000);
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

function rank(topics: CnTopic[]): void {
  topics.sort((a, b) => {
    const sa = a.heatScore ?? -1;
    const sb = b.heatScore ?? -1;
    if (sb !== sa) return sb - sa;
    return b.articles24h - a.articles24h || b.engagement - a.engagement;
  });
}

let cache: { at: number; ttl: number; snapshot: CnSnapshot } | null = null;
let inflight: Promise<CnSnapshot> | null = null;
/** 最近一轮抓到的全部 story —— cron 记基线要用，快照里只放每话题前 3 条。 */
let lastStories: { at: number; stories: CnStory[] } | null = null;

export function recentCnStories(maxAgeMs = 10 * 60 * 1000): CnStory[] {
  if (!lastStories) return [];
  if (Date.now() - lastStories.at > maxAgeMs) return [];
  return lastStories.stories;
}

export async function getCnTrending(force = false): Promise<CnSnapshot> {
  const now = Date.now();
  if (!force && cache && now - cache.at < cache.ttl) return cache.snapshot;
  if (inflight) return inflight;
  inflight = build(now).finally(() => {
    inflight = null;
  });
  return inflight;
}

async function build(now: number): Promise<CnSnapshot> {
  const fetched = await fetchCnStories(now);
  const history = await readCnHistory();
  const meta = cnHistoryMeta(history, now);
  const topics = aggregate(fetched.stories);
  enrich(topics, history, now);
  rank(topics);

  const degraded = [...fetched.degraded];
  if (meta.days === 0) degraded.push("cn:baseline_empty");
  else if (meta.pending) degraded.push("cn:baseline_partial");

  lastStories = { at: now, stories: fetched.stories };

  const snapshot: CnSnapshot = {
    fetchedAt: new Date(now).toISOString(),
    windowHours: WINDOW_HOURS,
    sources: fetched.sources,
    rawStories: fetched.rawStories,
    consideredStories: fetched.stories.length,
    topics,
    history: meta,
    degraded,
  };
  cache = { at: now, ttl: meta.pending ? CACHE_TTL_PENDING_MS : CACHE_TTL_MS, snapshot };
  if (topics.length === 0 && fetched.stories.length > 0) console.warn("[cn] 抓到故事但没命中实体");
  return snapshot;
}

/** 测试用：清掉进程内缓存，别让上一条用例的结果漏到下一条。 */
export function __testResetCnCache(): void {
  cache = null;
  inflight = null;
  lastStories = null;
}
