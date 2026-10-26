import { promises as fs } from "node:fs";
import path from "node:path";
import { matchTopicNamesZh } from "./topic-terms";

/**
 * 中文源的日基线（A 阶段）。
 *
 * 与 heat-history 的差别，以及为什么不能共用一份：
 *  1. 源不同。HN 一天 1000 条 story，IT之家 + 少数派一天不到 150 条 —— 同一条
 *     中线放在两条分布上，「多少条在提」的含义完全不同。混进同一份基线，等于
 *     用橘子的尺子量苹果，r7 会来回抽动。
 *  2. 攒法不同。HN 有 Algolia 的按时间检索接口，能往回抓 30 天把基线一次性补完；
 *     这两个中文源只给「最近 N 条」，没有历史检索能力。所以这里只能**从今天开始攒**：
 *     挂上之后每天读的时候顺手记一次，第 14 天才第一次出状态标签。
 *  3. 去重的必要性更硬。cron 每 30 分钟一轮，同一篇文章会被读 20 次以上；
 *     不做「当日唯一 URL」的记录，日计数会变成「轮次 × 条数」，全是假的。
 *
 * 所以：counts 只累加、seen 只留最近两天（当天去重用，跨 UTC 日界时昨天那份还得认）。
 */

export const CN_HISTORY_VERSION = 1;

/**
 * 攒够多少天才出状态标签。
 *
 * 这个数不是拍的：heat.ts 的 seriesStats() 少于 14 天直接返回 null（两周不到算不出
 * 「平时是什么样」）。这里跟着它走，免得基线 10 天时算得出 stats 却算不出状态。
 */
export const CN_BOOTSTRAP_DAYS = 14;

/** 保留多少天的日计数。45 天够算 median_30d，也不至于让文件一直长。 */
const MAX_DAYS = 45;
/** seen（当日已计数的 URL）只留两天：今天去重 + 次日零点前后那一轮的昨天。 */
const SEEN_KEEP_DAYS = 2;
/** 单个 URL 上限。一天 200 条也够，防的是上游异常时把文件撑爆。 */
const MAX_SEEN_URLS = 800;

const CACHE_DIR = path.join(process.cwd(), ".cache");
const CACHE_FILE = path.join(CACHE_DIR, "cn-history.json");

export type CnDay = { day: string; counts: Record<string, number> };
export type CnSeen = { day: string; urls: string[] };

export type CnHistory = {
  version: number;
  /** 最后一次落盘时间；从没写过是 null */
  builtAt: string | null;
  days: CnDay[];
  seen: CnSeen[];
};

export type CnHistoryMeta = {
  /** 已经攒到的天数（不含今天） */
  days: number;
  /** 出状态标签需要几天 */
  needed: number;
  from: string;
  to: string;
  builtAt: string | null;
  /** 还没攒够 —— 页面这时只显示名次，不给状态 */
  pending: boolean;
};

export type CnStoryLite = { title: string; url: string };

/** UTC 日界。跟 HN 那条一样按源的时间口径走，展示时再换算成本地。 */
export function utcDayOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function prevDay(day: string): string {
  return utcDayOf(Date.parse(day + "T00:00:00.000Z") - 24 * 3600 * 1000);
}

export function emptyCnHistory(): CnHistory {
  return { version: CN_HISTORY_VERSION, builtAt: null, days: [], seen: [] };
}

/**
 * 纯函数：把这一批 story 记进某个 UTC 日。
 *
 * 幂等的关键在 seen：URL 已经在今天的集合里就整条跳过（连带它命中的所有话题），
 * 所以同一批文章被 cron 读 20 遍，日计数只加一次。
 */
export function mergeCnDay(
  days: CnDay[],
  seen: CnSeen[],
  stories: CnStoryLite[],
  now: number,
): { days: CnDay[]; seen: CnSeen[]; day: string; added: number; topics: number; skipped: number } {
  const day = utcDayOf(now);

  const nextDays: CnDay[] = days.map((d) => ({ day: d.day, counts: { ...d.counts } }));
  let today = nextDays.find((d) => d.day === day);
  if (!today) {
    today = { day, counts: {} };
    nextDays.push(today);
  }

  const nextSeen: CnSeen[] = seen.map((s) => ({ day: s.day, urls: [...s.urls] }));
  let todaySeen = nextSeen.find((s) => s.day === day);
  if (!todaySeen) {
    todaySeen = { day, urls: [] };
    nextSeen.push(todaySeen);
  }
  const known = new Set(todaySeen.urls.flatMap((u) => (typeof u === "string" ? [u] : [])));

  let added = 0;
  let skipped = 0;
  const touched = new Set<string>();
  for (const story of stories) {
    const url = (story.url ?? "").trim();
    const title = (story.title ?? "").trim();
    if (!url || !title) continue;
    if (known.has(url)) {
      skipped++;
      continue;
    }
    const names = matchTopicNamesZh(title);
    if (names.length === 0) {
      // 没命中实体也要记 URL：否则它每轮都会被重新匹配一遍，白算。
      known.add(url);
      continue;
    }
    for (const name of names) {
      today.counts[name] = (today.counts[name] ?? 0) + 1;
      touched.add(name);
    }
    known.add(url);
    added++;
  }
  todaySeen.urls = [...known].slice(-MAX_SEEN_URLS);

  // 裁剪：日计数留最近 MAX_DAYS 天（按日字符串升序），seen 只留最近 SEEN_KEEP_DAYS 天。
  const keptDays = nextDays.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0)).slice(-MAX_DAYS);
  const keepSeen = new Set<string>([day, prevDay(day)]);
  for (let i = 1; i < SEEN_KEEP_DAYS; i++) keepSeen.add(prevDay(day));
  const keptSeen = nextSeen.filter((s) => keepSeen.has(s.day));

  return { days: keptDays, seen: keptSeen, day, added, topics: touched.size, skipped };
}

/** 某话题最近 take 天的日计数（**不含今天**），缺的日期补 0。 */
export function cnSeries(
  history: CnHistory | null,
  name: string,
  take = CN_BOOTSTRAP_DAYS,
  now = Date.now(),
): number[] {
  const out: number[] = [];
  if (!history) return out;
  const byDay = new Map(history.days.map((d) => [d.day, d.counts]));
  let day = utcDayOf(now);
  for (let i = 0; i < take; i++) {
    day = prevDay(day);
    out.push(byDay.get(day)?.[name] ?? 0);
  }
  // 上面是从昨天往回走的，翻成升序
  return out.reverse();
}

export function cnHistoryMeta(history: CnHistory | null, now = Date.now()): CnHistoryMeta {
  const days = history?.days.length ?? 0;
  const last = history?.days[history.days.length - 1]?.day ?? utcDayOf(now);
  const first = history?.days[0]?.day ?? utcDayOf(now);
  return {
    days,
    needed: CN_BOOTSTRAP_DAYS,
    from: first,
    to: last,
    builtAt: history?.builtAt ?? null,
    pending: days < CN_BOOTSTRAP_DAYS,
  };
}

/** 读盘。任何读/解析问题都当成「还没有基线」—— 基线丢了顶多不出状态，不该让首页 500。 */
export async function readCnHistory(): Promise<CnHistory> {
  try {
    const raw = await fs.readFile(CACHE_FILE, "utf8");
    const parsed = JSON.parse(raw) as Partial<CnHistory>;
    if (parsed.version !== CN_HISTORY_VERSION) return emptyCnHistory();
    const days = Array.isArray(parsed.days)
      ? parsed.days.filter(
          (d): d is CnDay =>
            !!d && typeof d.day === "string" && !!d.counts && typeof d.counts === "object",
        )
      : [];
    const seen = Array.isArray(parsed.seen)
      ? parsed.seen.filter(
          (s): s is CnSeen => !!s && typeof s.day === "string" && Array.isArray(s.urls),
        )
      : [];
    return {
      version: CN_HISTORY_VERSION,
      builtAt: typeof parsed.builtAt === "string" ? parsed.builtAt : null,
      days,
      seen,
    };
  } catch {
    return emptyCnHistory();
  }
}

async function writeCnHistory(history: CnHistory): Promise<void> {
  await fs.mkdir(CACHE_DIR, { recursive: true });
  const tmp = CACHE_FILE + "." + process.pid + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(history), "utf8");
  await fs.rename(tmp, CACHE_FILE);
}

/**
 * 把这一轮看到的 story 记进今天的计数。
 *
 * 失败只 warn 不抛：基线是「锦上添花」，它挂掉不该让 cron 整轮失败 ——
 * 那一轮的热榜、关注命中、清理都还要照常做。
 */
export async function recordCnStories(
  stories: CnStoryLite[],
  now = Date.now(),
): Promise<{ day: string; added: number; topics: number; skipped: number; days: number }> {
  const history = await readCnHistory();
  const merged = mergeCnDay(history.days, history.seen, stories, now);
  const next: CnHistory = {
    version: CN_HISTORY_VERSION,
    builtAt: new Date(now).toISOString(),
    days: merged.days,
    seen: merged.seen,
  };
  try {
    await writeCnHistory(next);
  } catch (err) {
    console.warn("[cn-history] 落盘失败：", err instanceof Error ? err.message : err);
  }
  return { day: merged.day, added: merged.added, topics: merged.topics, skipped: merged.skipped, days: merged.days.length };
}
