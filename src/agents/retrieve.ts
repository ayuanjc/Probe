
import type { Intent, RawSource } from "@/lib/schemas";
import { hostOf } from "@/lib/text";
import { searchTermFor } from "@/lib/entities";
import { fixtureSources } from "@/lib/fixtures";

/**
 * 检索层。四个 provider 之间完全隔离：任何一个失败只记入 degraded，
 * 不允许拖垮其他源（PRD 附录 C：单源失败仍能渲染 >= 1 模块）。
 */

const TIMEOUT_MS = 8_000;

/**
 * 超时信号与"客户端已断开"信号取并集。
 * 只挂 timeout 的话，用户关掉页面后这几条 fetch 还会各自跑满 8 秒，
 * 期间继续占用上游配额（GDELT 是每 IP 5 秒 1 次，浪费掉的配额会反过来咬自己）。
 */
function signalFor(timeoutMs: number, outer?: AbortSignal): AbortSignal {
  const t = AbortSignal.timeout(timeoutMs);
  return outer ? AbortSignal.any([t, outer]) : t;
}
/**
 * GDELT 被限流时不是立刻回 429——它要拖 12~14 秒才吐出那行纯文本。
 * 等它毫无意义：给它 2.5s 软超时，超了就当这次没赶上，失败后长冷却。
 * 首屏的延迟预算由最慢的源决定，不能由最不可靠的那个决定。
 */
const GDELT_TIMEOUT_MS = 2_500;
const DAY_MS = 86_400_000;

/** 意图里的时间窗转毫秒。解析失败时不设限，而不是悄悄退化成"全部"。 */
function windowBounds(intent: Intent): { fromMs: number; toMs: number } {
  const from = Date.parse(intent.timeRange.from);
  const to = Date.parse(intent.timeRange.to);
  return {
    fromMs: Number.isNaN(from) ? 0 : from,
    toMs: Number.isNaN(to) ? Date.now() + DAY_MS : to,
  };
}

/**
 * 窗口外一律丢弃。用户的"最近三个月"是显式约束，
 * 拿六年前的旧闻凑数量就是撒谎——宁可空，也不借时间窗外的证据。
 */
function inWindow(iso: string, fromMs: number, toMs: number): boolean {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return true; // 时间缺失不判为越界，但会单独记数
  return t >= fromMs && t <= toMs;
}

export type RetrieveResult = {
  sources: RawSource[];
  degraded: string[];
  /** 每个 provider 的实际返回条数，用于调试与空态提示。 */
  stats: Record<string, number>;
};

/** GDELT DOC 官方限制 1 req / 5s，超了直接 429。进程内串行化。 */
let gdeltChain: Promise<unknown> = Promise.resolve();
let gdeltLastAt = 0;
/** 被 429 之后的冷却窗口。GDELT 限流按 IP 计，冷却期内再打只会继续被拒。 */
let gdeltCooldownUntil = 0;
const GDELT_COOLDOWN_MS = 300_000;

async function gdeltSlot(fn: () => Promise<RawSource[]>): Promise<RawSource[]> {
  if (Date.now() < gdeltCooldownUntil) {
    throw new Error("gdelt cooldown");
  }
  const run = gdeltChain.then(async () => {
    const wait = Math.max(0, 5_000 - (Date.now() - gdeltLastAt));
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    gdeltLastAt = Date.now();
    return fn();
  });
  /**
   * 只有"被限流"和"超时"值得冷却。
   * 之前任何失败都冷却 5 分钟——一条查询语法写错，后面所有查询都被一并惩罚，
   * 这是把一次局部失败放大成一次全局停摆。
   */
  gdeltChain = run.catch((err: unknown) => {
    if (isRateLimited(err)) gdeltCooldownUntil = Date.now() + GDELT_COOLDOWN_MS;
    return undefined;
  });
  return run;
}

function isRateLimited(err: unknown): boolean {
  const m = err instanceof Error ? err.message : String(err);
  return /http 429|cooldown|abort|timeout/i.test(m);
}

/**
 * 媒体集团归属。独立性算的是 owner 数量，不是域名数量。
 * value 直接写可读名称：这个值会原样出现在信源列表和分布柱上，
 * 之前给的是 thomson-reuters / nikkei 这种内部代号，
 * 用户在同一列里同时看到 "nikkei" 和 "cnbc.com"，无从判断哪个是机构、哪个是站点。
 * 同一集团必须映射到同一个字符串（ft.com 归日经），否则归并就失效了。
 */
const OWNER_MAP: Record<string, string> = {
  "reuters.com": "路透社",
  "bloomberg.com": "彭博社",
  "nytimes.com": "纽约时报",
  "wsj.com": "道琼斯",
  "ft.com": "日经集团",
  "nikkei.com": "日经集团",
  "36kr.com": "36氪",
  "caixin.com": "财新",
  "yicai.com": "第一财经",
  "techcrunch.com": "TechCrunch",
  "theverge.com": "The Verge",
  "wired.com": "WIRED",
  "news.ycombinator.com": "Hacker News",
  "zhihu.com": "知乎",
  "weibo.com": "微博",
};

/**
 * 二级公共后缀。没有这张表，bbc.co.uk 与 ft.co.uk 都会被切成 "co.uk"，
 * 十几家互不相关的英国媒体归并成一个 owner，独立性直接归零。
 * 独立性是置信度里权重 0.35 的分量，这个错误会让整套分档失去意义。
 */
const MULTI_PART_TLD = new Set([
  "co.uk", "org.uk", "ac.uk", "gov.uk", "me.uk",
  "co.jp", "ne.jp", "or.jp", "co.kr",
  "com.cn", "net.cn", "org.cn", "gov.cn", "edu.cn",
  "com.au", "net.au", "org.au",
  "com.br", "com.mx", "com.ar", "co.in", "co.nz", "co.za", "com.tr",
  "com.hk", "com.tw", "com.sg", "com.my", "co.id", "co.th", "com.vn",
]);

function ownerOfDomain(domain: string): string {
  const d = domain.replace(/^www\./, "").toLowerCase();
  if (OWNER_MAP[d]) return OWNER_MAP[d];
  const parts = d.split(".");
  if (parts.length < 2) return d;
  const last2 = parts.slice(-2).join(".");
  if (MULTI_PART_TLD.has(last2)) return parts.slice(-3).join(".");
  return last2;
}

function gdeltDate(v: string): string {
  // 20261023T003000Z -> ISO
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(v);
  if (!m) return new Date().toISOString();
  return new Date(
    Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]),
  ).toISOString();
}

/* ---------------------------------------------------------------- GDELT */

async function fetchGdelt(intent: Intent, outer?: AbortSignal): Promise<RawSource[]> {
  // 关键：中文实体必须换成英文别名，否则 GDELT 必然 0 结果（索引以英文源为主）。
  const q =
    intent.entities.map((e) => '"' + searchTermFor(e) + '"').join(" OR ") || intent.query;
  const { fromMs, toMs } = windowBounds(intent);
  const stamp = (ms: number) => new Date(ms).toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const params = new URLSearchParams({
    query: q,
    mode: "ArtList",
    maxrecords: "75",
    format: "json",
    sort: "DateDesc",
    startdatetime: stamp(fromMs),
    enddatetime: stamp(toMs),
  });
  const url = "https://api.gdeltproject.org/api/v2/doc/doc?" + params.toString();

  const res = await fetch(url, {
    signal: signalFor(GDELT_TIMEOUT_MS, outer),
    cache: "no-store",
  });
  if (!res.ok) throw new Error("gdelt http " + res.status);
  const text = await res.text();
  // GDELT 在限流/无结果时返回非 JSON 的纯文本，必须先判形。
  if (!text.trimStart().startsWith("{")) throw new Error("gdelt non-json response");

  const json = JSON.parse(text) as { articles?: Record<string, string>[] };
  return (json.articles ?? []).slice(0, 50).map((a, i) => {
    const domain = a.domain ?? hostOf(a.url ?? "");
    return {
      id: "gd-" + i,
      url: a.url ?? "",
      domain,
      owner: ownerOfDomain(domain),
      title: a.title ?? "(untitled)",
      snippet: "",
      lang: (a.language ?? "unknown").toLowerCase(),
      publishedAt: gdeltDate(a.seendate ?? ""),
      provider: "gdelt" as const,
    };
  });
}

/* ---------------------------------------------------------------- HN */

async function fetchHn(intent: Intent, outer?: AbortSignal): Promise<RawSource[]> {
  // HN 是英文索引，中文整句检索必然 0 命中。
  const terms = intent.entities.map(searchTermFor).filter(Boolean);
  const q = (terms.length > 0 ? terms.join(" ") : intent.query).slice(0, 80);
  // 不加时间过滤的话，Algolia 返回的是全历史相关性排序：
  // "NVIDIA" 会带回 2018 年收购 Arm 的旧闻，和用户的窗口毫无关系。
  const { fromMs, toMs } = windowBounds(intent);
  const url =
    "https://hn.algolia.com/api/v1/search?query=" +
    encodeURIComponent(q) +
    "&tags=story&hitsPerPage=40" +
    "&numericFilters=" +
    encodeURIComponent(
      "created_at_i>=" + Math.floor(fromMs / 1000) + ",created_at_i<=" + Math.floor(toMs / 1000),
    );
  const res = await fetch(url, { signal: signalFor(TIMEOUT_MS, outer), cache: "no-store" });
  if (!res.ok) throw new Error("hn http " + res.status);
  const json = (await res.json()) as {
    hits?: { objectID: string; title?: string; story_title?: string; url?: string; created_at: string; points?: number }[];
  };
  // HN 是发现层而不是单一媒体：每条 story 的 url 指向各自的原始站点。
  // 把 owner 一律记成 ycombinator 会让"独立信源数"永远是 1，
  // 置信度里 35% 权重的独立性分量就变成常数——那等于自己骗自己。
  return (json.hits ?? []).map((h, i) => {
    const external = h.url && /^https?:/i.test(h.url);
    const domain = external ? hostOf(h.url!) : "news.ycombinator.com";
    return {
      id: "hn-" + i,
      url: external ? h.url! : "https://news.ycombinator.com/item?id=" + h.objectID,
      domain,
      owner: external ? ownerOfDomain(domain) : "ycombinator",
      title: h.title ?? h.story_title ?? "(untitled)",
      snippet: "",
      lang: "en",
      publishedAt: h.created_at,
      provider: "hn" as const,
    };
  });
}

/* ---------------------------------------------------------------- Wiki */

async function fetchWiki(intent: Intent, outer?: AbortSignal): Promise<RawSource[]> {
  const entity = intent.entities.find((e) => e.type !== "event");
  if (!entity) return [];

  const to = new Date();
  const from = new Date(to.getTime() - 30 * 86_400_000);
  const fmt = (d: Date) => d.toISOString().slice(0, 10).replace(/-/g, "");
  const title = encodeURIComponent(searchTermFor(entity).replace(/ /g, "_"));

  const res = await fetch(
    "https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/en.wikipedia/all-access/user/" +
      title +
      "/daily/" +
      fmt(from) +
      "/" +
      fmt(to),
    { signal: signalFor(TIMEOUT_MS, outer), cache: "no-store" },
  );
  if (!res.ok) throw new Error("wiki http " + res.status);

  const json = (await res.json()) as { items?: { timestamp: string; views: number }[] };
  const items = json.items ?? [];
  if (items.length === 0) return [];

  const peak = items.reduce((a, b) => (b.views > a.views ? b : a), items[0]);
  const ts = peak.timestamp; // YYYYMMDDHH
  const iso = new Date(
    Date.UTC(+ts.slice(0, 4), +ts.slice(4, 6) - 1, +ts.slice(6, 8), +ts.slice(8, 10)),
  ).toISOString();

  return [
    {
      id: "wk-0",
      url: "https://en.wikipedia.org/wiki/" + title,
      domain: "en.wikipedia.org",
      owner: "wikimedia",
      title: entity.name + " 维基百科页面浏览量峰值 " + peak.views + " / 日",
      snippet: "维基百科该实体页面单日浏览量峰值 " + peak.views + "（近 30 天）。",
      lang: "en",
      publishedAt: iso,
      provider: "wiki" as const,
    },
  ];
}

/* ---------------------------------------------------------------- Tavily */

async function fetchTavily(intent: Intent, outer?: AbortSignal): Promise<RawSource[]> {
  const key = process.env.TAVILY_API_KEY;
  if (!key) return [];

  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      // 官方已改用 Bearer；body 里的 api_key 是废弃写法，新账号会直接 401。
      authorization: "Bearer " + key,
    },
    body: JSON.stringify({
      query: intent.query,
      search_depth: "basic",
      max_results: 15,
      include_raw_content: false,
      start_date: intent.timeRange.from.slice(0, 10),
      end_date: intent.timeRange.to.slice(0, 10),
    }),
    signal: signalFor(TIMEOUT_MS, outer),
    cache: "no-store",
  });
  if (!res.ok) throw new Error("tavily http " + res.status);

  const json = (await res.json()) as {
    results?: { url: string; title: string; content: string; published_date?: string }[];
  };
  return (json.results ?? []).map((r, i) => {
    const domain = hostOf(r.url);
    return {
      id: "tv-" + i,
      url: r.url,
      domain,
      owner: ownerOfDomain(domain),
      title: r.title,
      snippet: r.content.slice(0, 400),
      lang: "unknown",
      publishedAt: r.published_date ?? new Date().toISOString(),
      provider: "tavily" as const,
    };
  });
}

/* ---------------------------------------------------------------- 编排 */

export async function retrieve(intent: Intent, signal?: AbortSignal): Promise<RetrieveResult> {
  const degraded: string[] = [];
  const stats: Record<string, number> = {};

  const jobs: { name: string; run: () => Promise<RawSource[]> }[] = [
    { name: "gdelt", run: () => gdeltSlot(() => fetchGdelt(intent, signal)) },
    { name: "hn", run: () => fetchHn(intent, signal) },
    { name: "wiki", run: () => fetchWiki(intent, signal) },
    { name: "tavily", run: () => fetchTavily(intent, signal) },
  ];

  const settled = await Promise.allSettled(jobs.map((j) => j.run()));
  const out: RawSource[] = [];

  settled.forEach((s, i) => {
    const name = jobs[i].name;
    if (s.status === "fulfilled") {
      stats[name] = s.value.length;
      // 没 key 的 tavily 返回空是预期行为，不算降级；其他源空结果要说出来。
      if (s.value.length === 0 && name !== "tavily") degraded.push(name + ":empty");
      out.push(...s.value);
    } else {
      stats[name] = 0;
      degraded.push(name);
    }
  });

  // 各 provider 已经带上服务端时间过滤，这里再兜一层：
  // 有的源（尤其是 Wiki 这种派生条目、Tavily 的 published_date）会忽略参数。
  const { fromMs, toMs } = windowBounds(intent);
  const kept = out.filter((s) => inWindow(s.publishedAt, fromMs, toMs));
  const dropped = out.length - kept.length;
  if (dropped > 0) stats["window:dropped"] = dropped;
  const undated = kept.filter((s) => Number.isNaN(Date.parse(s.publishedAt))).length;
  if (undated > 0) stats["window:undated"] = undated;

  // 全空或全失败：落 fixture，绝不返回空白页（PRD 附录 B 空态要求）。
  // 注意"窗口内确实没有"和"源挂了"是两件事，分别标明，不混成一条降级。
  if (kept.length === 0) {
    if (dropped > 0) degraded.push("window:empty");
    degraded.push("fixture");
    const fx = fixtureSources(intent.query);
    stats.fixture = fx.length;
    return { sources: fx, degraded, stats };
  }

  return { sources: kept, degraded, stats };
}