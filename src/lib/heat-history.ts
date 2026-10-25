import { promises as fs } from "node:fs";
import path from "node:path";
import { matchTopicNames } from "./topic-terms";

/**
 * 历史基线：把 HN 过去的每日话题条数攒成一条日序列，热度公式才有分母。
 *
 * 没有基线的热榜只能排名次，说不出「今天是不是异常」—— 12 条可能是平常，
 * 也可能是从 2 条跳上来的。PRD 2.3 的 r7 与 MAD 全都要日序列，所以这里负责攒它。
 *
 * 三个刻意的决定：
 *  1. 日界用 UTC。HN 的时间戳是 UTC，日界跟着源走，展示时再换算；混用本地日界
 *     会让「昨天」变成 32 小时或 16 小时。
 *  2. 窗口 12 小时。实测 12h 内最多约 850 条 story，压在 Algolia 单页 1000 条以内；
 *     再宽就会被截断，而截断的基线会偏小 —— 偏小的基线会把普通一天误判成爆发。
 *  3. 结果落 .cache 而不是内存。首次构建要跑 60 次请求，进程重启不该重来一遍。
 */

const HN_ENDPOINT = "https://hn.algolia.com/api/v1/search_by_date";
const FETCH_TIMEOUT_MS = 15_000;
const CONCURRENCY = 4;
const PAGE_LIMIT = 1000;
// 一条窗口的真 hit 数接近单页上限时先对半拆，避免截断被当成「那天只有这么多」。
const SPLIT_THRESHOLD = 990;

// v2：口径改为与实时快照一致（只数 points >= MIN_POINTS、同一天按 url 去重）。
// 不升版本，旧缓存会一直用宽口径（把 0 分 story 与重复提交都算进去），r7 被系统性压低。
export const HISTORY_VERSION = 2;
/** 首次构建往回抓多少天：30 天刚好够算 median_30d 与 MAD_30d。 */
export const BOOTSTRAP_DAYS = 30;
/** 上限 90 天，攒够了就不再往更远处抓。 */
export const HISTORY_MAX_DAYS = 90;
export const TRAIN_HOURS = 12;
// 只落后几天就当场补完；落后更多先拿旧基线出榜，后台悄悄补。
const SYNC_CATCHUP_DAYS = 3;

/**
 * 一条没人看的 story 提到某词，不构成「这个词热」，只构成「这个词出现过」。
 *
 * 这个阈值必须与实时快照（src/lib/trending.ts）用同一个值：
 * 基线按宽口径数、分子按窄口径数，r7 会系统性偏低 —— 每个话题都像在回落。
 */
export const MIN_POINTS = 2;

const CACHE_DIR = path.join(process.cwd(), ".cache");
const CACHE_FILE = path.join(CACHE_DIR, "hn-history.json");

export type HistoryDay = { day: string; counts: Record<string, number> };

export type History = {
  version: number;
  builtAt: string;
  /** 覆盖区间（UTC 日界，闭区间） */
  from: string;
  to: string;
  days: HistoryDay[];
};

export type HistoryState = {
  history: History | null;
  /** true = 基线还没准备好（首次构建中 / 落后太多正在补） */
  pending: boolean;
  reason?: "building" | "stale";
};

type HnHit = {
  objectID: string;
  title: string | null;
  url: string | null;
  points: number | null;
  created_at_i: number;
};

function dayKeyOf(sec: number): string {
  /*
   * 上游少给一个字段就是 RangeError：new Date(NaN).toISOString() 直接抛，
   * 而 collect() 里这个调用在 try 之外（try 只包了 fetchWindow），
   * 于是**整份基线**因为一条脏数据构建失败，首页永远 pending。
   * 返回空串，由调用方跳过这一条。
   */
  if (!Number.isFinite(sec)) return "";
  const d = new Date(sec * 1000);
  if (Number.isNaN(d.getTime())) return "";
  return d.toISOString().slice(0, 10);
}

function todayStartUtc(): number {
  return Math.floor(Date.now() / 1000 / 86400) * 86400;
}

function dayNumber(day: string): number {
  return Math.floor(Date.parse(day + "T00:00:00Z") / 1000);
}

/** 从「今天 00:00 UTC」往回切 12h 窗口；12h 正好是 UTC 日界的两半，日计数不会串桶。 */
function windowRanges(days: number): { a: number; b: number }[] {
  const end = todayStartUtc();
  const start = end - days * 86400;
  const width = TRAIN_HOURS * 3600;
  const out: { a: number; b: number }[] = [];
  for (let b = end; b > start; b -= width) out.push({ a: Math.max(start, b - width), b });
  return out;
}

async function fetchWindow(a: number, b: number): Promise<HnHit[]> {
  const filter = encodeURIComponent("created_at_i>=" + a + ",created_at_i<" + b);
  const url = HN_ENDPOINT + "?tags=story&numericFilters=" + filter + "&hitsPerPage=" + PAGE_LIMIT;
  const res = await fetch(url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    cache: "no-store",
    headers: { "user-agent": "probe/0.1 (+https://github.com/ayuanjc/Probe)" },
  });
  if (!res.ok) throw new Error("hn http " + res.status);
  const json = (await res.json()) as { hits?: HnHit[] };
  const hits = json.hits ?? [];
  if (hits.length >= SPLIT_THRESHOLD && b - a > 600) {
    const mid = Math.floor((a + b) / 2);
    const halves = await Promise.all([fetchWindow(a, mid), fetchWindow(mid, b)]);
    return [...halves[0], ...halves[1]];
  }
  return hits;
}

async function pool<T, R>(items: T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let cursor = 0;
  const lanes = new Array(Math.min(size, Math.max(items.length, 1))).fill(0).map(async () => {
    for (;;) {
      const at = cursor++;
      if (at >= items.length) return;
      out[at] = await fn(items[at]);
    }
  });
  await Promise.all(lanes);
  return out;
}

/** 把命中按 UTC 日聚合成「话题 -> 条数」。失败的窗口只让那半天缺，不拖垮整批。 */
async function collect(ranges: { a: number; b: number }[]): Promise<Map<string, Record<string, number>>> {
  const byDay = new Map<string, Record<string, number>>();
  let failed = 0;
  const chunks = await pool(ranges, CONCURRENCY, async (r) => {
    try {
      return await fetchWindow(r.a, r.b);
    } catch (err) {
      failed++;
      console.warn("[heat-history] window failed:", err instanceof Error ? err.message : err);
      return [] as HnHit[];
    }
  });
  if (ranges.length > 0 && failed === ranges.length) throw new Error("hn_all_windows_failed");
  // 与实时快照同一套去重：同一篇外链一天内被重复提交是常态，
  // 那是提交次数，不是「多少条在提这个词」。
  const seenByDay = new Map<string, Set<string>>();
  for (const hit of chunks.flat()) {
    const title = (hit.title ?? "").trim();
    if (title.length < 8) continue;
    if ((hit.points ?? 0) < MIN_POINTS) continue;
    const day = dayKeyOf(hit.created_at_i);
    if (!day) continue;
    const link = hit.url ?? "hn:" + hit.objectID;
    const seen = seenByDay.get(day) ?? new Set<string>();
    if (seen.has(link)) continue;
    seen.add(link);
    seenByDay.set(day, seen);
    const counts = byDay.get(day) ?? {};
    for (const name of matchTopicNames(title)) counts[name] = (counts[name] ?? 0) + 1;
    byDay.set(day, counts);
  }
  return byDay;
}

function mergeDays(
  base: Map<string, Record<string, number>>,
  add: Map<string, Record<string, number>>,
): Map<string, Record<string, number>> {
  for (const [day, counts] of add) {
    const cur = base.get(day) ?? {};
    for (const [name, n] of Object.entries(counts)) cur[name] = (cur[name] ?? 0) + n;
    base.set(day, cur);
  }
  return base;
}

function toHistory(byDay: Map<string, Record<string, number>>): History {
  const days = [...byDay.entries()]
    .map(([day, counts]) => ({ day, counts }))
    .sort((x, y) => (x.day < y.day ? -1 : x.day > y.day ? 1 : 0))
    // 只留最近 HISTORY_MAX_DAYS 天：更早的日子对 r7 没有贡献，留着只让文件变大。
    .slice(-HISTORY_MAX_DAYS);
  return {
    version: HISTORY_VERSION,
    builtAt: new Date().toISOString(),
    from: days[0]?.day ?? "",
    to: days[days.length - 1]?.day ?? "",
    days,
  };
}

function isHistory(v: unknown): v is History {
  if (!v || typeof v !== "object") return false;
  const h = v as Partial<History>;
  if (h.version !== HISTORY_VERSION) return false;
  if (typeof h.from !== "string" || typeof h.to !== "string") return false;
  if (!Array.isArray(h.days)) return false;
  /*
   * 缓存文件是本机产物，但也是**跨版本/跨手改**的输入，形状必须逐项验：
   *   - to 解析不了（如 "2026-13-45"）→ extend() 里 daysBack 变 NaN →
   *     窗口为空 → `b > start` 恒假 → 空基线原样写回，进入「永远 stale、永远重建」；
   *   - 某个 day 缺 counts → dailySeries 读 d.counts[topic] 抛 TypeError，
   *     被上层 catch 吞掉，首页永远 pending，日志里什么都没有。
   * 这两种都表现为「页面一直转圈」，而原因在缓存文件里，最难查。
   */
  if (!Number.isFinite(Date.parse(h.from + "T00:00:00Z"))) return false;
  if (!Number.isFinite(Date.parse(h.to + "T00:00:00Z"))) return false;
  for (const d of h.days) {
    if (!d || typeof d !== "object") return false;
    const day = d as Partial<HistoryDay>;
    if (typeof day.day !== "string") return false;
    if (!Number.isFinite(Date.parse(day.day + "T00:00:00Z"))) return false;
    const counts = day.counts;
    if (!counts || typeof counts !== "object" || Array.isArray(counts)) return false;
    for (const [topic, n] of Object.entries(counts)) {
      if (typeof topic !== "string" || !Number.isFinite(n)) return false;
    }
  }
  return true;
}

async function readCache(): Promise<History | null> {
  try {
    const raw = await fs.readFile(CACHE_FILE, "utf8");
    const parsed: unknown = JSON.parse(raw);
    return isHistory(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function writeCache(history: History): Promise<void> {
  try {
    await fs.mkdir(CACHE_DIR, { recursive: true });
    // 先写临时文件再 rename：中途被打断也不会留下半个 JSON 让下次启动读崩。
    const tmp = CACHE_FILE + ".tmp";
    await fs.writeFile(tmp, JSON.stringify(history), "utf8");
    await fs.rename(tmp, CACHE_FILE);
  } catch (err) {
    console.warn("[heat-history] cache write failed:", err instanceof Error ? err.message : err);
  }
}

/** 从 prev 的最后一天往后补到今天之前（不含今天：今天由实时快照负责）。 */
async function extend(prev: History | null): Promise<History> {
  const yesterday = dayKeyOf(todayStartUtc() - 86400);
  if (prev && prev.to >= yesterday) return prev;

  const base = new Map<string, Record<string, number>>();
  for (const d of prev?.days ?? []) base.set(d.day, { ...d.counts });

  let daysBack = BOOTSTRAP_DAYS;
  if (prev && prev.to) {
    const gap = Math.round((dayNumber(yesterday) - dayNumber(prev.to)) / 86400);
    daysBack = Math.max(1, Math.min(gap, HISTORY_MAX_DAYS));
  }
  const fetched = await collect(windowRanges(daysBack));
  const history = toHistory(mergeDays(base, fetched));
  await writeCache(history);
  return history;
}

let memo: History | null = null;
let inflight: Promise<History | null> | null = null;

/**
 * 首页调用它。**不等**构建：没有缓存就立刻返回 pending，把 60 次请求丢到后台。
 * 让首页等 20 秒换一份基线不划算 —— 榜单本身不该依赖它才有内容可看。
 */
export async function ensureHistory(): Promise<HistoryState> {
  if (memo) return { history: memo, pending: false };
  const cached = await readCache();
  const yesterday = dayKeyOf(todayStartUtc() - 86400);

  if (cached && cached.to >= yesterday) {
    memo = cached;
    return { history: memo, pending: false };
  }

  if (!inflight) {
    inflight = extend(cached)
      .then((h) => {
        memo = h;
        return h;
      })
      .catch((err) => {
        console.warn("[heat-history] build failed:", err instanceof Error ? err.message : err);
        return null;
      })
      .finally(() => {
        inflight = null;
      });
  }

  if (cached) {
    const gap = Math.round((dayNumber(yesterday) - dayNumber(cached.to)) / 86400);
    if (gap <= SYNC_CATCHUP_DAYS) {
      const fresh = await inflight;
      if (fresh) return { history: fresh, pending: false };
    }
    memo = cached;
    void inflight;
    return { history: cached, pending: true, reason: "stale" };
  }

  void inflight;
  return { history: null, pending: true, reason: "building" };
}

/** 预热/测试用：直接等构建完成（页面不走这条）。 */
export async function warmHistory(): Promise<History | null> {
  const cached = await readCache();
  const h = await extend(cached);
  memo = h;
  return h;
}

/** 某个话题按日期升序的日计数；缺那天记 0。 */
export function dailySeries(history: History, topic: string): { dates: string[]; counts: number[] } {
  return {
    dates: history.days.map((d) => d.day),
    // counts 可能缺（历史缓存来自旧版本），可选链兜住；index 侧已校验。
    counts: history.days.map((d) => d.counts?.[topic] ?? 0),
  };
}
