import type { StoryLite } from "./watch-store";

/**
 * 国内热议（榜单轨）。
 *
 * 与 `trending.ts` 的区别不是"又一个源"，而是**数据形态不同**：
 * 热榜吃的是「24 小时文章量 + 30 天日序列」，而国内能白拿到的微博/知乎/百度
 * 给的都是**榜单**（一条标题 + 一个热度值），没有"多少篇文章在提"这件事。
 * 硬塞进热度公式等于让基线凭空重攒 —— 所以这里是独立的第二条轨：
 * 只做展示与「关注命中」，不参与 heatScore，也不影响任何状态标签。
 *
 * 实测事实（2026-10-26，腾讯云广州机器上 curl 过一遍）：
 *   - 百度热搜 pc 榜单 200，50 条，`hotScore` 7809327 → 3149404，带 `desc` 与 `hotChange`
 *   - 掘金 hot_rank 200，50 条，但 `ctime` 恒为 0（没有发布时间）→ 出不了趋势
 *   - 微博 403、知乎 401、V2EX 000 超时 → 不接，别在页面上写"正在接入"
 *
 * 一句话口径：这是「别人此刻在加热什么」，不是「我们算出来的热度」。
 */

const BAIDU_ENDPOINT = "https://top.baidu.com/api/board?platform=pc&tab=realtime";
const JUEJIN_ENDPOINT =
  "https://api.juejin.cn/content_api/v1/content/article_rank?category_id=1&type=hot";

const FETCH_TIMEOUT_MS = 6_000;
/** 榜单是分钟到小时级更新的，15 分钟足够；也把上游请求压到每天 ~96 次。 */
const CACHE_TTL_MS = 15 * 60 * 1000;
/** 失败别钉住：下一轮 cron 就该再试一次。 */
const CACHE_TTL_FAILED_MS = 60 * 1000;
const MAX_ENTRIES = 50;

/**
 * 上游要一个像浏览器的 UA：百度的 board 接口对默认 UA 会回空 cards。
 * 这里不伪装成浏览器版本号，只报自己是谁 —— 被拒就降级，不玩猫捉老鼠。
 */
const UA = "ProbeHotlist/1.0 (+https://ayuanjc.online)";

export type HotChange = "new" | "up" | "same";

export type HotEntry = {
  /** 榜单名次，从 1 开始（用我们自己的顺序，不照搬上游的 index） */
  rank: number;
  title: string;
  url: string;
  host: string;
  /** 上游给的摘要（只有百度有）；一律截断，不整段搬 */
  summary?: string;
  /** 上游的热度数值 —— 不是我们的分，所以只用于排序与展示 */
  score: number | null;
  /** 这个数值到底是什么（「百度热度」「阅读」），必须写清楚 */
  scoreLabel: string;
  change?: HotChange;
};

export type HotList = {
  provider: "baidu" | "juejin";
  label: string;
  /** 一句话说明这个榜是什么，直接印在界面上 */
  note: string;
  /** 上游自己的刷新时间（百度有）；没有就缺省 */
  updatedAt?: string;
  fetchedAt: string;
  entries: HotEntry[];
};

export type HotListsSnapshot = {
  fetchedAt: string;
  lists: HotList[];
  degraded: string[];
};

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim()) {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

function httpUrl(v: unknown): string {
  const s = str(v);
  if (!s) return "";
  // 只接受 http(s)：javascript: / data: 这类到了 <a href> 上就是 XSS 入口。
  if (!/^https?:\/\//i.test(s)) return "";
  try {
    const u = new URL(s);
    return u.protocol === "http:" || u.protocol === "https:" ? u.toString() : "";
  } catch {
    return "";
  }
}

/** 12345 → 「1.2 万」；榜单数字很大，原样印出来占位。 */
export function formatCount(n: number | null): string {
  if (n === null) return "—";
  if (n < 10000) return String(Math.round(n));
  const wan = n / 10000;
  return (wan >= 100 ? Math.round(wan) : Math.round(wan * 10) / 10) + " 万";
}

function changeOf(v: unknown): HotChange | undefined {
  const s = str(v).toLowerCase();
  if (!s) return undefined;
  // 百度这边实测只有 same / up / 空；"new" 走的是 hotTag，归到 undefined 不猜。
  if (s === "same") return "same";
  if (s === "up" || s === "rise" || s === "rising") return "up";
  if (s === "new") return "new";
  return undefined;
}

/**
 * 百度热搜：`data.cards[*].content` 是个数组（历史上有过嵌套层级变化），
 * 所以按"能遍历到的对象里带 query/title 且带链接"来认，而不是写死下标。
 */
export function parseBaiduBoard(json: unknown): HotEntry[] {
  const out: HotEntry[] = [];
  const seen = new Set<string>();
  const cards = (json as { data?: { cards?: unknown } } | null)?.data?.cards;
  if (!Array.isArray(cards)) return out;

  const walk = (node: unknown, depth: number): void => {
    if (depth > 4 || out.length >= MAX_ENTRIES) return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1);
      return;
    }
    if (!node || typeof node !== "object") return;
    const o = node as Record<string, unknown>;
    const title = str(o.query) || str(o.word) || str(o.title);
    const url = httpUrl(o.appUrl) || httpUrl(o.url) || httpUrl(o.rawUrl);
    if (title && url) {
      if (seen.has(url)) return;
      seen.add(url);
      const summary = str(o.desc).replace(/\s+/g, " ").slice(0, 120);
      out.push({
        rank: out.length + 1,
        title: title.slice(0, 160),
        url,
        host: hostOf(url) || "baidu.com",
        summary: summary || undefined,
        score: num(o.hotScore),
        scoreLabel: "百度热度",
        change: changeOf(o.hotChange),
      });
      return;
    }
    for (const key of ["content", "hotList", "topContent", "items"]) {
      if (o[key]) walk(o[key], depth + 1);
    }
  };

  walk(cards, 0);
  return out;
}

/** 掘金热榜：`data[]`，每条 `content.content_id/title` + `content_counter`。 */
export function parseJuejinRank(json: unknown): HotEntry[] {
  const rows = (json as { data?: unknown } | null)?.data;
  if (!Array.isArray(rows)) return [];
  const out: HotEntry[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (out.length >= MAX_ENTRIES) break;
    const r = row as { content?: Record<string, unknown>; content_counter?: Record<string, unknown> };
    const content = r?.content ?? {};
    const counter = r?.content_counter ?? {};
    const id = str(content.content_id) || (typeof content.content_id === "number" ? String(content.content_id) : "");
    const title = str(content.title);
    // 只拼数字 id：content_id 一旦被上游污染成路径片段，这里就成了开放跳转。
    if (!/^\d{6,}$/.test(id) || !title) continue;
    const url = "https://juejin.cn/post/" + id;
    if (seen.has(url)) continue;
    seen.add(url);
    const view = num(counter.view);
    const hot = num(counter.hot_rank);
    out.push({
      rank: out.length + 1,
      title: title.slice(0, 160),
      url,
      host: "juejin.cn",
      score: hot ?? view,
      scoreLabel: view !== null ? "阅读 " + formatCount(view) : "热门序 " + (hot ?? "—"),
      // 掘金不给发布时间，所以这里也没有 change —— 没有的东西不要补。
    });
  }
  return out;
}

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, {
    headers: { "user-agent": UA, accept: "application/json, text/plain, */*" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    cache: "no-store",
  });
  if (!res.ok) throw new Error("HTTP " + res.status);
  return res.json();
}

export function hotlistEnabled(): boolean {
  return process.env.PROBE_HOTLIST_SERVER !== "0";
}

function sources(): ("baidu" | "juejin")[] {
  const raw = (process.env.PROBE_HOTLIST_SOURCES ?? "baidu,juejin").toLowerCase();
  const want = new Set(raw.split(/[,\s]+/).filter(Boolean));
  const out: ("baidu" | "juejin")[] = [];
  if (want.has("baidu")) out.push("baidu");
  if (want.has("juejin")) out.push("juejin");
  return out;
}

const LABELS: Record<"baidu" | "juejin", { label: string; note: string; endpoint: string; parse: (j: unknown) => HotEntry[] }> = {
  baidu: {
    label: "百度热搜",
    note: "百度热搜榜原始条目与热度值，按榜单顺序展示；热度是百度给的，不是我们算的。",
    endpoint: BAIDU_ENDPOINT,
    parse: parseBaiduBoard,
  },
  juejin: {
    label: "掘金热榜",
    note: "掘金热门技术文 50 条。上游不提供发布时间，所以这里没有趋势、没有状态标签。",
    endpoint: JUEJIN_ENDPOINT,
    parse: parseJuejinRank,
  },
};

let cache: { at: number; ttl: number; snapshot: HotListsSnapshot } | null = null;
let inflight: Promise<HotListsSnapshot> | null = null;

export async function getHotLists(force = false): Promise<HotListsSnapshot> {
  if (!hotlistEnabled()) {
    return { fetchedAt: new Date().toISOString(), lists: [], degraded: ["hotlist:disabled"] };
  }
  const now = Date.now();
  if (!force && cache && now - cache.at < cache.ttl) return cache.snapshot;
  if (inflight) return inflight;
  inflight = build(now).finally(() => {
    inflight = null;
  });
  return inflight;
}

async function build(now: number): Promise<HotListsSnapshot> {
  const fetchedAt = new Date(now).toISOString();
  const degraded: string[] = [];
  const lists: HotList[] = [];

  const results = await Promise.all(
    sources().map(async (provider) => {
      const def = LABELS[provider];
      // 一次重试：实测同分钟里前一次成功、后一次超时，直接判死会把整块榜单清空 15 分钟。
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const entries = def.parse(await fetchJson(def.endpoint));
          if (entries.length === 0) throw new Error("empty");
          return { provider, entries, error: null as string | null };
        } catch (err) {
          if (attempt === 1) {
            return {
              provider,
              entries: [] as HotEntry[],
              error: provider + ":" + (err instanceof Error && err.message === "empty" ? "empty" : "failed"),
            };
          }
        }
      }
      return { provider, entries: [] as HotEntry[], error: provider + ":failed" };
    }),
  );

  for (const r of results) {
    if (r.error) {
      degraded.push(r.error);
      console.warn("[hotlist] " + r.error);
      continue;
    }
    const def = LABELS[r.provider];
    lists.push({
      provider: r.provider,
      label: def.label,
      note: def.note,
      fetchedAt,
      entries: r.entries,
    });
  }

  if (lists.length === 0) degraded.push("hotlist:empty");
  const anyFailed = degraded.some((d) => d.endsWith(":failed") || d.endsWith(":empty"));
  const snapshot: HotListsSnapshot = { fetchedAt, lists, degraded };
  cache = { at: now, ttl: anyFailed ? CACHE_TTL_FAILED_MS : CACHE_TTL_MS, snapshot };
  return snapshot;
}

/**
 * 摊平成关注匹配要的形状。
 *
 * 与热榜那批 story 的区别写在 provider 上：命中列表里会显示「百度热搜」/「掘金」
 * 而不是混成一条「热榜」。points 直接用上游热度值 —— 它本来就是"这条有多热"的票面。
 */
export function hotStories(snapshot: HotListsSnapshot): StoryLite[] {
  const out: StoryLite[] = [];
  const seen = new Set<string>();
  for (const list of snapshot.lists) {
    for (const e of list.entries) {
      if (!e.url || seen.has(e.url)) continue;
      seen.add(e.url);
      out.push({
        title: e.title,
        url: e.url,
        host: e.host,
        provider: list.provider,
        points: e.score === null ? 0 : Math.round(e.score),
        seenAt: list.fetchedAt,
      });
    }
  }
  return out;
}

/** 测试用：清缓存。 */
export function __testResetHotlist(): void {
  cache = null;
  inflight = null;
}
