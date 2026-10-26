/**
 * 实体追踪（公开）：词典里的公司 / 技术在热榜里被提到的时间线。
 *
 * 与 watch_hits 的分工，改之前先读：
 *   - watch_hits 是**私人的**：一行绑一个 user_id，只回答「我关注的那个今天有没有动静」。
 *   - entity_hits 是**公开的**：没有 user_id，只回答「这个词今天被哪些源提到」。
 *     所以它既能做 /e/台积电 这种不需要登录的页面，也不会泄漏任何人的行为。
 *
 * 三条口径：
 *   1. 只存索引：标题 + 链接 + 来源 + 热度 + 时间；正文与模型输出不落库。
 *   2. 只认词典里的实体（src/lib/entities.ts）。这不是 NER，宁可少记也不乱记 ——
 *      把「苹果价格」记成苹果公司，时间线就废了。歧义词沿用 watch-match 的上下文正则。
 *   3. UNIQUE(entity_key, url)：cron 每半小时跑一遍，同一条新闻只算一次。
 */
import { getDb } from "@/lib/db";
import { readPositiveInt } from "@/lib/rate-limit";
import { hashText } from "@/lib/history-store";
import { ALIASES } from "@/lib/entities";
import { matchStory, type WatchKind } from "@/lib/watch-match";

export type EntityHit = {
  id: string;
  key: string;
  name: string;
  kind: WatchKind;
  url: string;
  title: string;
  host: string | null;
  provider: string | null;
  points: number;
  seenAt: string | null;
  at: number;
};

export type EntitySummary = {
  key: string;
  name: string;
  kind: WatchKind;
  total: number;
  last24h: number;
  last7d: number;
  firstAt: number | null;
  lastAt: number | null;
  sources: { provider: string; n: number }[];
};

export type TopEntity = {
  key: string;
  name: string;
  kind: WatchKind;
  total: number;
  last24h: number;
  lastAt: number | null;
};

export type EntityStory = {
  title: string;
  url: string;
  host?: string | null;
  provider?: string | null;
  points?: number;
  seenAt?: string | null;
};

export function entityEnabled(): boolean {
  return (process.env.PROBE_ENTITY_SERVER ?? "1").trim() !== "0";
}

/** 每个实体最多留多少条（时间线超过这个数没人会翻）。 */
export function hitsPerEntity(): number {
  return readPositiveInt("PROBE_ENTITY_HITS_PER_KEY", 200, { max: 1000 });
}

/** 命中保留天数。与 watch 同一档默认值，运维只要记一个数。 */
export function entityRetentionDays(): number {
  return readPositiveInt("PROBE_ENTITY_HIT_DAYS", 30, { max: 365 });
}

const CJK = /[\u4e00-\u9fa5]/;

type DictEntity = { key: string; name: string; kind: WatchKind; aliases: string[] };

let dictCache: DictEntity[] | null = null;

/**
 * 太泛的别名不进实体表。判断标准不是"它是不是一个词"，而是"它出现在标题里还算不算一条情报"：
 * "电动自行车保暖与安全如何两全"命中了"安全"，这是背景噪音，不是有人在谈安全行业。
 */
const GENERIC_ALIASES = new Set(["安全", "security"]);

/** 词典 → 实体表。键取展示名的小写，与 watchKeyOf 对词典命名的口径保持一致。 */
export function dictEntities(): DictEntity[] {
  if (dictCache) return dictCache;
  const out: DictEntity[] = [];
  const seen = new Set<string>();
  for (const entry of ALIASES) {
    // 展示名优先用 zh[0]，但前提是它真是中文。词典里有几行 zh[0] 写的是英文
    // （openai / anthropic），照抄就会把"欧朋艾""克劳德"这种音译当成主名 ——
    // 读者认的是 OpenAI，不是音译。这种情况退回 en。
    const first = String(entry.zh[0] ?? "").trim();
    const name = (CJK.test(first) ? first : (entry.en || entry.zh.find((z) => CJK.test(z)) || "")).trim();
    const key = name.toLowerCase();
    if (!key || seen.has(key) || GENERIC_ALIASES.has(key)) continue;
    seen.add(key);
    const aliases: string[] = [];
    for (const a of [...entry.zh, entry.en]) {
      const v = String(a ?? "").trim();
      if (v && !aliases.some((x) => x.toLowerCase() === v.toLowerCase())) aliases.push(v);
    }
    out.push({ key, name, kind: entry.type as WatchKind, aliases });
  }
  dictCache = out;
  return out;
}

/** 一条标题里出现的所有词典实体（纯函数，单测友好）。 */
export function entitiesInTitle(title: string): DictEntity[] {
  const hay = String(title ?? "");
  if (!hay) return [];
  const out: DictEntity[] = [];
  for (const entity of dictEntities()) {
    if (matchStory({ aliases: entity.aliases }, hay).matched) out.push(entity);
  }
  return out;
}

function num(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

/**
 * 上游给的发布时间 → 毫秒。拿不到就退回「现在」。
 *
 * 为什么要这道换算：时间线是按时间读的，而 cron 一轮抓到的所有 story
 * 落库时间戳完全相同。直接用 created_at 排，跨来源的顺序等于插入顺序，
 * 三天前的旧闻被抓到当天也会排在最上面。
 *
 * 容错三条：非 ISO 解析不出来 → 用 now；未来时间（上游时区写错）→ 用 now；
 * 早于 1970 的脏值 → 用 now。宁可退回抓取时间，也不让一条脏数据把时间线拉到 1969 年。
 */
function pubMsOf(story: EntityStory, now: number): number {
  const raw = story.seenAt ? String(story.seenAt).trim() : "";
  if (!raw) return now;
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms) || ms <= 0) return now;
  if (ms > now + 3_600_000) return now;
  return Math.floor(ms);
}

function randomId(): string {
  try {
    return globalThis.crypto.randomUUID();
  } catch {
    return hashText(String(Date.now()) + Math.random()) + Date.now().toString(36);
  }
}

function asKind(raw: unknown): WatchKind {
  const v = String(raw ?? "");
  return v === "org" || v === "tech" || v === "person" || v === "geo" || v === "event" ? (v as WatchKind) : "other";
}

/**
 * 落库一轮命中（由 cron/heat 调用）。
 *
 * 返回 inserted / matched（去重前命中数）/ pruned（因每实体上限删掉的条数）。
 * 任何一步失败都抛给调用方 —— cron 那里包了 try/catch，写库失败不能影响热榜。
 */
export function recordEntityHits(
  stories: readonly EntityStory[],
  now = Date.now(),
): { inserted: number; matched: number; pruned: number } {
  const db = getDb();
  const cap = hitsPerEntity();
  const touched = new Set<string>();
  let matched = 0;
  let inserted = 0;

  db.exec("BEGIN IMMEDIATE");
  try {
    const insert = db.prepare(
      "INSERT OR IGNORE INTO entity_hits (id, entity_key, name, kind, url, title, host, provider, points, seen_at, created_at, pub_at)" +
        " VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
    );
    for (const story of stories) {
      const url = String(story.url ?? "").trim();
      const title = String(story.title ?? "").trim();
      if (!url || !title) continue;
      for (const entity of entitiesInTitle(title)) {
        matched += 1;
        const res = insert.run(
          randomId(),
          entity.key,
          entity.name,
          entity.kind,
          url.slice(0, 2_000),
          title.slice(0, 300),
          story.host ? String(story.host).slice(0, 120) : null,
          story.provider ? String(story.provider).slice(0, 24) : null,
          num(story.points),
          story.seenAt ? String(story.seenAt).slice(0, 40) : null,
          now,
          pubMsOf(story, now),
        );
        const changed = Number(res.changes) || 0;
        inserted += changed;
        if (changed) touched.add(entity.key);
      }
    }

    // 每个实体只留最近 cap 条：热榜是流，不封顶的话单条时间线会变成一本电话簿。
    const trim = db.prepare(
      "DELETE FROM entity_hits WHERE entity_key = ? AND id NOT IN" +
        " (SELECT id FROM entity_hits WHERE entity_key = ? ORDER BY created_at DESC, id DESC LIMIT ?)",
    );
    let pruned = 0;
    for (const key of touched) {
      const res = trim.run(key, key, cap);
      pruned += Number(res.changes) || 0;
    }
    db.exec("COMMIT");
    return { inserted, matched, pruned };
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

/** 清掉超过保留期的命中。cron 每轮调一次，返回删除行数。 */
export function pruneEntityHits(limit = 500, now = Date.now()): number {
  const cutoff = now - entityRetentionDays() * 86_400_000;
  const db = getDb();
  const res = db
    .prepare("DELETE FROM entity_hits WHERE id IN (SELECT id FROM entity_hits WHERE created_at < ? LIMIT ?)")
    .run(cutoff, Math.max(1, Math.floor(limit)));
  return Number(res.changes) || 0;
}

function rowToHit(row: Record<string, unknown>): EntityHit {
  return {
    id: String(row.id ?? ""),
    key: String(row.entity_key ?? ""),
    name: String(row.name ?? ""),
    kind: asKind(row.kind),
    url: String(row.url ?? ""),
    title: String(row.title ?? ""),
    host: row.host === null || row.host === undefined ? null : String(row.host),
    provider: row.provider === null || row.provider === undefined ? null : String(row.provider),
    points: num(row.points),
    seenAt: row.seen_at === null || row.seen_at === undefined ? null : String(row.seen_at),
    // at 是「这条新闻发生的时间」，不是「我们抓到它的时间」。两者都在库里（pub_at / created_at），
    // 对外只暴露前者：读者看的是事件，不是我们的抓取节奏。
    at: num(row.pub_at) || num(row.created_at),
  };
}

/** 某个实体的时间线，游标分页（before = 上一页最后一条的 at）。 */
export function listEntityHits(
  key: string,
  opts: { limit?: number; before?: number } = {},
): { items: EntityHit[]; next: number | null } {
  const limit = Math.min(Math.max(Math.floor(opts.limit ?? 40), 1), 200);
  const before = Number(opts.before ?? 0);
  const db = getDb();
  const rows = (
    before > 0
      ? db
          .prepare(
            "SELECT * FROM entity_hits WHERE entity_key = ? AND pub_at < ?" +
              " ORDER BY pub_at DESC, created_at DESC, id DESC LIMIT ?",
          )
          .all(key, before, limit + 1)
      : db
          .prepare(
            "SELECT * FROM entity_hits WHERE entity_key = ?" +
              " ORDER BY pub_at DESC, created_at DESC, id DESC LIMIT ?",
          )
          .all(key, limit + 1)
  ) as Record<string, unknown>[];
  const items = rows.slice(0, limit).map(rowToHit);
  const next = rows.length > limit ? items[items.length - 1]?.at ?? null : null;
  return { items, next };
}

/** 一个实体的概览（页头那几行数字）。不存在时 total=0、名字回落到 key。 */
export function entitySummary(key: string, now = Date.now()): EntitySummary {
  const normalized = String(key ?? "").trim().toLowerCase();
  const db = getDb();
  const head = db
    .prepare(
      // 一律按 pub_at 算：三天前的旧闻今天才被抓到，不该算进「24 小时」。
      "SELECT name, kind, COUNT(*) AS total, MIN(pub_at) AS first_at, MAX(pub_at) AS last_at," +
        " SUM(CASE WHEN pub_at >= ? THEN 1 ELSE 0 END) AS last24," +
        " SUM(CASE WHEN pub_at >= ? THEN 1 ELSE 0 END) AS last7" +
        " FROM entity_hits WHERE entity_key = ?",
    )
    .get(now - 86_400_000, now - 7 * 86_400_000, normalized) as Record<string, unknown> | undefined;
  const sources = db
    .prepare(
      "SELECT COALESCE(provider, 'unknown') AS provider, COUNT(*) AS n FROM entity_hits" +
        " WHERE entity_key = ? GROUP BY provider ORDER BY n DESC LIMIT 6",
    )
    .all(normalized) as Record<string, unknown>[];
  const dict = dictEntities().find((e) => e.key === normalized);
  return {
    key: normalized,
    name: head?.name ? String(head.name) : dict?.name ?? String(key ?? ""),
    kind: head?.kind ? asKind(head.kind) : dict?.kind ?? "other",
    total: num(head?.total),
    last24h: num(head?.last24),
    last7d: num(head?.last7),
    firstAt: head?.first_at === null || head?.first_at === undefined ? null : num(head.first_at),
    lastAt: head?.last_at === null || head?.last_at === undefined ? null : num(head.last_at),
    sources: sources.map((r) => ({ provider: String(r.provider ?? "unknown"), n: num(r.n) })),
  };
}

/** 最近 N 天被提到最多的实体。days=0 表示全部。 */
export function topEntities(opts: { days?: number; limit?: number } = {}, now = Date.now()): TopEntity[] {
  const days = Math.max(0, Math.floor(opts.days ?? 7));
  const limit = Math.min(Math.max(Math.floor(opts.limit ?? 20), 1), 100);
  const since = days > 0 ? now - days * 86_400_000 : 0;
  const db = getDb();
  const rows = db
    .prepare(
      "SELECT entity_key, MAX(name) AS name, MAX(kind) AS kind, COUNT(*) AS total," +
        " SUM(CASE WHEN pub_at >= ? THEN 1 ELSE 0 END) AS last24, MAX(pub_at) AS last_at" +
        " FROM entity_hits WHERE pub_at >= ? GROUP BY entity_key ORDER BY total DESC, last_at DESC LIMIT ?",
    )
    .all(now - 86_400_000, since, limit) as Record<string, unknown>[];
  return rows.map((r) => ({
    key: String(r.entity_key ?? ""),
    name: String(r.name ?? ""),
    kind: asKind(r.kind),
    total: num(r.total),
    last24h: num(r.last24),
    lastAt: r.last_at === null || r.last_at === undefined ? null : num(r.last_at),
  }));
}

/** 运维口径：库里现在有多少条、覆盖多少个实体。 */
export function entityStats(): { hits: number; entities: number; oldestAt: number | null } {
  const db = getDb();
  const row = db
    .prepare("SELECT COUNT(*) AS hits, COUNT(DISTINCT entity_key) AS entities, MIN(created_at) AS oldest FROM entity_hits")
    .get() as Record<string, unknown> | undefined;
  return {
    hits: num(row?.hits),
    entities: num(row?.entities),
    oldestAt: row?.oldest === null || row?.oldest === undefined ? null : num(row.oldest),
  };
}

/** 测试用：清空实体表。只在测试里调。 */
export function __testResetEntities(): void {
  try {
    getDb().exec("DELETE FROM entity_hits");
  } catch {
    // 库还没建：没什么可清。
  }
}
