/**
 * 关注实体与命中（P1 关注实体回流的存储层）。
 *
 * 四条口径，改之前先读：
 *   1. **只存索引**：关注名 + 命中的标题/URL/host/points。正文与模型输出不落库，
 *      与 queries 同一口径 —— 落库等于我们变成内容托管方。
 *   2. **一条新闻只算一次命中**：UNIQUE(watch_id, url)。cron 每 5 分钟跑一遍，
 *      没有这条约束就会把同一条 story 反复塞进未读，用户第一次就会关掉未读数。
 *   3. **不推就不记**：歧义命中（苹果 / 小米 / 长城…）直接跳过，只计数，不入库。
 *      推错一次的代价比漏推一次高得多。
 *   4. **写库失败不能影响热榜**：cron 里 recordHits 包在 try/catch 里，失败只打日志。
 */
import { getDb } from "@/lib/db";
import { readPositiveInt } from "@/lib/rate-limit";
import { historyEnabled, hashText } from "@/lib/history-store";
import { matchStory, watchKeyOf, type WatchKind } from "@/lib/watch-match";

export type WatchRow = {
  id: string;
  name: string;
  key: string;
  kind: WatchKind;
  createdAt: number;
  /** 历史命中总数（含已读） */
  hits: number;
  /** 未读数 */
  unread: number;
  /** 最近一条命中的时间；没有命中为 null */
  lastSeenAt: number | null;
};

export type WatchHit = {
  id: string;
  watchId: string;
  watchName: string;
  url: string;
  title: string | null;
  host: string | null;
  provider: string | null;
  points: number;
  seenAt: string | null;
  at: number;
  read: boolean;
};

/** 一条热榜条目（cron 传进来的最小形状）。 */
export type StoryLite = {
  title: string;
  url: string;
  host?: string | null;
  provider?: string | null;
  points?: number;
  seenAt?: string | null;
};

export function watchEnabled(): boolean {
  // 关注与历史同一个库：历史关掉就没有库，关注也无处可写。
  if (!historyEnabled()) return false;
  return (process.env.PROBE_WATCH_SERVER ?? "1").trim() !== "0";
}

export function perUserWatchCap(): number {
  return readPositiveInt("PROBE_WATCH_PER_USER", 50, { max: 500 });
}

export function hitsPerWatch(): number {
  return readPositiveInt("PROBE_WATCH_HITS_PER_WATCH", 50, { max: 500 });
}

export function hitRetentionDays(): number {
  return readPositiveInt("PROBE_WATCH_HIT_DAYS", 30, { max: 365 });
}

function num(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

function randomId(): string {
  try {
    return globalThis.crypto.randomUUID();
  } catch {
    return hashText(String(Date.now()) + Math.random()) + Date.now().toString(36);
  }
}

function parseAliases(raw: unknown): string[] {
  if (typeof raw !== "string" || !raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is string => typeof x === "string").slice(0, 24);
  } catch {
    return [];
  }
}

const KINDS = ["org", "tech", "person", "geo", "event", "other"];

function asKind(value: unknown): WatchKind {
  const v = String(value ?? "");
  return KINDS.includes(v) ? (v as WatchKind) : "other";
}

/** 加关注。同一个关注（同一 key）重复添加是幂等的，返回已有那条。 */
export function addWatch(userId: string, input: { name: string; kind?: string; now?: number }): { watch: WatchRow; created: boolean } {
  const key = watchKeyOf(input.name);
  if (!key) throw new Error("watch_bad_name");
  const db = getDb();
  const now = Number.isFinite(input.now) ? Number(input.now) : Date.now();

  const existing = db
    .prepare("SELECT id, name, key, kind, created_at FROM watches WHERE user_id = ? AND key = ?")
    .get(userId, key.key) as Record<string, unknown> | undefined;
  if (existing) return { watch: rowToWatch(existing, 0, 0, null), created: false };

  const used = db.prepare("SELECT COUNT(*) AS n FROM watches WHERE user_id = ?").get(userId) as { n?: number } | undefined;
  if (num(used?.n) >= perUserWatchCap()) throw new Error("watch_cap");

  const id = randomId();
  const kind = input.kind && KINDS.includes(String(input.kind)) ? asKind(input.kind) : key.kind;
  db.prepare("INSERT INTO watches (id, user_id, name, key, aliases, kind, created_at) VALUES (?,?,?,?,?,?,?)").run(
    id,
    userId,
    key.name,
    key.key,
    JSON.stringify(key.aliases),
    kind,
    now,
  );
  return { watch: { id, name: key.name, key: key.key, kind, createdAt: now, hits: 0, unread: 0, lastSeenAt: null }, created: true };
}

export function removeWatch(userId: string, id: string): boolean {
  const db = getDb();
  const res = db.prepare("DELETE FROM watches WHERE id = ? AND user_id = ?").run(id, userId);
  return Number(res.changes) > 0;
}

export function clearWatches(userId: string): number {
  const db = getDb();
  const res = db.prepare("DELETE FROM watches WHERE user_id = ?").run(userId);
  return Number(res.changes) || 0;
}

function rowToWatch(r: Record<string, unknown>, hits: number, unread: number, lastSeen: number | null): WatchRow {
  return {
    id: String(r.id ?? ""),
    name: String(r.name ?? ""),
    key: String(r.key ?? ""),
    kind: asKind(r.kind),
    createdAt: num(r.created_at),
    hits,
    unread,
    lastSeenAt: lastSeen,
  };
}

/** 我的关注 + 未读数 + 最近命中时间（一次查询，避免 N+1）。 */
export function listWatches(userId: string): WatchRow[] {
  const db = getDb();
  const rows = db
    .prepare(
      "SELECT w.id, w.name, w.key, w.kind, w.created_at," +
        " (SELECT COUNT(*) FROM watch_hits h WHERE h.watch_id = w.id) AS hits," +
        " (SELECT COUNT(*) FROM watch_hits h WHERE h.watch_id = w.id AND h.read_at IS NULL) AS unread," +
        " (SELECT MAX(created_at) FROM watch_hits h WHERE h.watch_id = w.id) AS last_seen" +
        " FROM watches w WHERE w.user_id = ? ORDER BY w.created_at DESC",
    )
    .all(userId) as Record<string, unknown>[];
  return rows.map((r) =>
    rowToWatch(r, num(r.hits), num(r.unread), r.last_seen === null || r.last_seen === undefined ? null : num(r.last_seen)),
  );
}

export function countUnread(userId: string): number {
  const db = getDb();
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM watch_hits WHERE user_id = ? AND read_at IS NULL")
    .get(userId) as { n?: number } | undefined;
  return num(row?.n);
}

export type HitsResult = { hits: { watchId: string; story: StoryLite }[]; ambiguous: number };

/**
 * 纯匹配：把所有关注 × 所有热榜条目过一遍，返回该入库的命中。
 * 不碰数据库，方便单测；顺序稳定（watches 顺序 × stories 顺序）。
 */
export function matchHits(
  watches: readonly { id: string; aliases: readonly string[] }[],
  stories: readonly StoryLite[],
): HitsResult {
  const hits: { watchId: string; story: StoryLite }[] = [];
  let ambiguous = 0;
  for (const w of watches) {
    for (const story of stories) {
      if (!story.url || !story.title) continue;
      const outcome = matchStory({ aliases: w.aliases as string[] }, story.title);
      if (outcome.matched) hits.push({ watchId: w.id, story });
      else if (outcome.ambiguous) ambiguous += 1;
    }
  }
  return { hits, ambiguous };
}

/**
 * 落库一轮命中（由 cron/heat 调用）。
 * 返回入库条数、因歧义跳过的次数、因条数上限删掉的老命中。
 */
export function recordHits(stories: readonly StoryLite[], now = Date.now()): { inserted: number; ambiguous: number; pruned: number } {
  const db = getDb();
  const rows = db.prepare("SELECT id, user_id, aliases FROM watches").all() as Record<string, unknown>[];
  if (rows.length === 0) return { inserted: 0, ambiguous: 0, pruned: 0 };

  const byId = new Map(rows.map((r) => [String(r.id ?? ""), String(r.user_id ?? "")]));
  const matched = matchHits(
    rows.map((r) => ({ id: String(r.id ?? ""), aliases: parseAliases(r.aliases) })),
    stories,
  );

  let inserted = 0;
  let pruned = 0;
  const touched = new Set<string>();
  db.exec("BEGIN IMMEDIATE");
  try {
    const insert = db.prepare(
      "INSERT OR IGNORE INTO watch_hits (id, watch_id, user_id, url, title, host, provider, points, seen_at, created_at, read_at)" +
        " VALUES (?,?,?,?,?,?,?,?,?,?,NULL)",
    );
    for (const hit of matched.hits) {
      const userId = byId.get(hit.watchId);
      if (!userId) continue;
      const res = insert.run(
        randomId(),
        hit.watchId,
        userId,
        hit.story.url.slice(0, 2_000),
        hit.story.title.slice(0, 300),
        hit.story.host ? hit.story.host.slice(0, 120) : null,
        hit.story.provider ? hit.story.provider.slice(0, 24) : null,
        num(hit.story.points),
        hit.story.seenAt ? hit.story.seenAt.slice(0, 40) : null,
        now,
      );
      inserted += Number(res.changes) || 0;
      touched.add(hit.watchId);
    }
    // 每个关注只留最近 N 条：热榜是流，不设上限的话「未读」会变成一本书。
    const trim = db.prepare(
      "DELETE FROM watch_hits WHERE watch_id = ? AND id NOT IN (" +
        " SELECT id FROM watch_hits WHERE watch_id = ? ORDER BY created_at DESC LIMIT ?)",
    );
    const cap = hitsPerWatch();
    for (const watchId of touched) {
      const before = db.prepare("SELECT COUNT(*) AS n FROM watch_hits WHERE watch_id = ?").get(watchId) as
        | { n?: number }
        | undefined;
      if (num(before?.n) <= cap) continue;
      const res = trim.run(watchId, watchId, cap);
      pruned += Number(res.changes) || 0;
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return { inserted, ambiguous: matched.ambiguous, pruned };
}

export type ListHitsOptions = { watchId?: string | null; limit?: number; before?: number | null; unreadOnly?: boolean };

export function listHits(userId: string, opts: ListHitsOptions = {}): { items: WatchHit[]; next: number | null } {
  const db = getDb();
  const limit = Math.min(Math.max(Math.floor(Number(opts.limit ?? 20) || 20), 1), 50);
  const before = Number.isFinite(opts.before) ? Number(opts.before) : null;
  const where: string[] = ["h.user_id = ?"];
  const params: unknown[] = [userId];
  if (opts.watchId) {
    where.push("h.watch_id = ?");
    params.push(String(opts.watchId));
  }
  if (before !== null) {
    where.push("h.created_at < ?");
    params.push(before);
  }
  if (opts.unreadOnly) where.push("h.read_at IS NULL");

  const rows = db
    .prepare(
      "SELECT h.id, h.watch_id, h.url, h.title, h.host, h.provider, h.points, h.seen_at, h.created_at, h.read_at, w.name AS watch_name" +
        " FROM watch_hits h JOIN watches w ON w.id = h.watch_id" +
        " WHERE " + where.join(" AND ") +
        " ORDER BY h.created_at DESC LIMIT ?",
    )
    .all(...params, limit + 1) as Record<string, unknown>[];

  const items = rows.slice(0, limit).map((r) => ({
    id: String(r.id ?? ""),
    watchId: String(r.watch_id ?? ""),
    watchName: String(r.watch_name ?? ""),
    url: String(r.url ?? ""),
    title: typeof r.title === "string" ? r.title : null,
    host: typeof r.host === "string" ? r.host : null,
    provider: typeof r.provider === "string" ? r.provider : null,
    points: num(r.points),
    seenAt: typeof r.seen_at === "string" ? r.seen_at : null,
    at: num(r.created_at),
    read: r.read_at !== null && r.read_at !== undefined,
  }));
  const next = rows.length > limit ? items[items.length - 1]?.at ?? null : null;
  return { items, next };
}

/** 标记已读。只影响自己的行；不存在的 id 静默跳过（幂等）。 */
export function markRead(userId: string, ids: readonly string[]): number {
  if (ids.length === 0) return 0;
  const db = getDb();
  const now = Date.now();
  const stmt = db.prepare("UPDATE watch_hits SET read_at = ? WHERE id = ? AND user_id = ? AND read_at IS NULL");
  let changed = 0;
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const id of ids.slice(0, 200)) {
      const res = stmt.run(now, String(id), userId);
      changed += Number(res.changes) || 0;
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return changed;
}

export function markAllRead(userId: string, watchId?: string | null): number {
  const db = getDb();
  const now = Date.now();
  const res = watchId
    ? db
        .prepare("UPDATE watch_hits SET read_at = ? WHERE user_id = ? AND watch_id = ? AND read_at IS NULL")
        .run(now, userId, String(watchId))
    : db.prepare("UPDATE watch_hits SET read_at = ? WHERE user_id = ? AND read_at IS NULL").run(now, userId);
  return Number(res.changes) || 0;
}

/** 过期命中清理（默认 30 天）：挂在 cron/heat 上，与历史清理同一处。 */
export function pruneHits(limit = 500): number {
  const db = getDb();
  const cutoff = Date.now() - hitRetentionDays() * 86_400_000;
  const res = db
    .prepare("DELETE FROM watch_hits WHERE id IN (SELECT id FROM watch_hits WHERE created_at <= ? LIMIT ?)")
    .run(cutoff, Math.max(1, Math.min(5_000, Math.floor(limit))));
  return Number(res.changes) || 0;
}

/**
 * 建议关注：从自己最近 200 条历史的 entities 里按出现次数给出前 N 个。
 * 只建议、不自动关注 —— 自动关注等于替用户决定他关心什么。
 */
export function suggestWatches(userId: string, limit = 5): string[] {
  const db = getDb();
  const rows = db
    .prepare("SELECT entities FROM queries WHERE user_id = ? ORDER BY created_at DESC LIMIT 200")
    .all(userId) as Record<string, unknown>[];
  const counts = new Map<string, number>();
  for (const r of rows) {
    for (const name of parseAliases(r.entities)) {
      const v = name.trim();
      if (v.length < 2) continue;
      counts.set(v, (counts.get(v) ?? 0) + 1);
    }
  }
  const existing = new Set(listWatches(userId).map((w) => w.key));
  return [...counts.entries()]
    .filter(([name]) => !existing.has(name.trim().toLowerCase()))
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, Math.max(1, Math.min(10, limit)))
    .map(([name]) => name);
}

/** 后台「设置」用：关注与命中的总行数。 */
export function watchStats(): { watches: number; hits: number; unread: number } {
  const db = getDb();
  const one = (sql: string) => num((db.prepare(sql).get() as { n?: number } | undefined)?.n);
  return {
    watches: one("SELECT COUNT(*) AS n FROM watches"),
    hits: one("SELECT COUNT(*) AS n FROM watch_hits"),
    unread: one("SELECT COUNT(*) AS n FROM watch_hits WHERE read_at IS NULL"),
  };
}
