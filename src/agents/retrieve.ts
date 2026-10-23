
import type { Intent, RawSource } from "@/lib/schemas";
import { hostOf } from "@/lib/text";
import { searchTermFor } from "@/lib/entities";
import { fixtureSources } from "@/lib/fixtures";

/**
 * 检索层。四个 provider 之间完全隔离：任何一个失败只记入 degraded，
 * 不允许拖垮其他源（PRD 附录 C：单源失败仍能渲染 >= 1 模块）。
 */

const TIMEOUT_MS = 8_000;

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
const GDELT_COOLDOWN_MS = 60_000;

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
  gdeltChain = run.catch(() => {
    gdeltCooldownUntil = Date.now() + GDELT_COOLDOWN_MS;
    return undefined;
  });
  return run;
}

/** 媒体集团归属。独立性算的是 owner 数量，不是域名数量。 */
const OWNER_MAP: Record<string, string> = {
  "reuters.com": "thomson-reuters",
  "bloomberg.com": "bloomberg",
  "nytimes.com": "nytimes",
  "wsj.com": "dow-jones",
  "ft.com": "nikkei",
  "nikkei.com": "nikkei",
  "36kr.com": "36kr",
  "caixin.com": "caixin",
  "yicai.com": "yicai",
  "techcrunch.com": "techcrunch",
  "theverge.com": "vox-media",
  "wired.com": "condenast",
  "news.ycombinator.com": "ycombinator",
  "zhihu.com": "zhihu",
  "weibo.com": "weibo",
};

function ownerOfDomain(domain: string): string {
  const d = domain.replace(/^www\./, "").toLowerCase();
  if (OWNER_MAP[d]) return OWNER_MAP[d];
  const parts = d.split(".");
  return parts.length >= 2 ? parts.slice(-2).join(".") : d;
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

async function fetchGdelt(intent: Intent): Promise<RawSource[]> {
  // 关键：中文实体必须换成英文别名，否则 GDELT 必然 0 结果（索引以英文源为主）。
  const q =
    intent.entities.map((e) => '"' + searchTermFor(e) + '"').join(" OR ") || intent.query;
  const params = new URLSearchParams({
    query: q,
    mode: "ArtList",
    maxrecords: "50",
    format: "json",
    sort: "DateDesc",
  });
  const url = "https://api.gdeltproject.org/api/v2/doc/doc?" + params.toString();

  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), cache: "no-store" });
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

async function fetchHn(intent: Intent): Promise<RawSource[]> {
  // HN 是英文索引，中文整句检索必然 0 命中。
  const terms = intent.entities.map(searchTermFor).filter(Boolean);
  const q = (terms.length > 0 ? terms.join(" ") : intent.query).slice(0, 80);
  const url =
    "https://hn.algolia.com/api/v1/search?query=" +
    encodeURIComponent(q) +
    "&tags=story&hitsPerPage=20";
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), cache: "no-store" });
  if (!res.ok) throw new Error("hn http " + res.status);
  const json = (await res.json()) as {
    hits?: { objectID: string; title?: string; story_title?: string; url?: string; created_at: string; points?: number }[];
  };
  return (json.hits ?? []).map((h, i) => ({
    id: "hn-" + i,
    url: h.url ?? "https://news.ycombinator.com/item?id=" + h.objectID,
    domain: "news.ycombinator.com",
    owner: "ycombinator",
    title: h.title ?? h.story_title ?? "(untitled)",
    snippet: "",
    lang: "en",
    publishedAt: h.created_at,
    provider: "hn" as const,
  }));
}

/* ---------------------------------------------------------------- Wiki */

async function fetchWiki(intent: Intent): Promise<RawSource[]> {
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
    { signal: AbortSignal.timeout(TIMEOUT_MS), cache: "no-store" },
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

async function fetchTavily(intent: Intent): Promise<RawSource[]> {
  const key = process.env.TAVILY_API_KEY;
  if (!key) return [];

  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      api_key: key,
      query: intent.query,
      search_depth: "basic",
      max_results: 15,
      include_raw_content: false,
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
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

export async function retrieve(intent: Intent): Promise<RetrieveResult> {
  const degraded: string[] = [];
  const stats: Record<string, number> = {};

  const jobs: { name: string; run: () => Promise<RawSource[]> }[] = [
    { name: "gdelt", run: () => gdeltSlot(() => fetchGdelt(intent)) },
    { name: "hn", run: () => fetchHn(intent) },
    { name: "wiki", run: () => fetchWiki(intent) },
    { name: "tavily", run: () => fetchTavily(intent) },
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

  // 全空或全失败：落 fixture，绝不返回空白页（PRD 附录 B 空态要求）。
  if (out.length === 0) {
    degraded.push("fixture");
    const fx = fixtureSources(intent.query);
    stats.fixture = fx.length;
    return { sources: fx, degraded, stats };
  }

  return { sources: out, degraded, stats };
}
