/**
 * 账号级历史（P0 的存储层）。
 *
 * 三条口径，写在最前面，改之前先读：
 *   1. **只存索引，不存内容**：query、面板统计、信源 URL、引文的 hash。
 *      正文与模型输出永不落库 —— 落库就等于我们变成内容托管方：要审、要删、要担责。
 *   2. **保留期是字段，不是约定**：写入时就把 expires_at 算好（默认 30 天），
 *      清理任务只看它，不靠「我记得要删」。
 *   3. **写库失败不能影响主流程**：历史是附加价值。调用方必须 try/catch，
 *      这里也只在真出错时抛，不吞 —— 吞了就没法在 journalctl 里看见。
 */
import { createHash } from "node:crypto";

import { getDb } from "@/lib/db";
import { readPositiveInt } from "@/lib/rate-limit";

export type SavedSource = {
  url: string;
  title: string | null;
  provider: string;
  quoteHash: string | null;
};

export type NewQuery = {
  userId: string;
  query: string;
  region: string;
  modelHost?: string | null;
  intentKind?: string | null;
  entities?: readonly string[];
  summaryLen?: number;
  claims?: number;
  supported?: number;
  contradicted?: number;
  unknownN?: number;
  degraded?: readonly string[];
  sources?: readonly SavedSource[];
  docHash?: string | null;
  elapsedMs?: number;
  now?: number;
};

export type HistoryCounts = {
  claims: number;
  supported: number;
  contradicted: number;
  unknown: number;
};

export type HistoryRow = {
  id: string;
  query: string;
  at: number;
  region: string;
  intentKind: string | null;
  counts: HistoryCounts;
  degraded: string[];
  sources: number;
  hosts: string[];
};

export type HistoryDetail = HistoryRow & { sourceRows: SavedSource[]; elapsedMs: number };

/** 总开关：关掉后写入与读取都像功能不存在（接口返回空，界面隐藏）。 */
export function historyEnabled(): boolean {
  return (process.env.PROBE_HISTORY_SERVER ?? "1").trim() !== "0";
}

/** 是否保存提问原文。关掉后只留一个 hash —— 列表里显示「（已隐去）」。 */
export function storeQueryText(): boolean {
  return (process.env.PROBE_HISTORY_STORE_QUERY ?? "1").trim() !== "0";
}

export function retentionDays(): number {
  /*
   * 默认 30 天（2026-10-26 由 90 收紧）。理由是隐私口径：账号级历史里存的是「他问过什么」，
   * 这是这套数据里最敏感的一类。90 天能多回看一些，但代价是「上个月的好奇心」长期留在一个
   * 单机 SQLite 里；30 天足够撑住「我记得我搜过那个词」这个真实用途。
   * 想放宽就改这个环境变量 —— 但改大之前先看 docs/OPS.md 的容量表。
   */
  return readPositiveInt("PROBE_HISTORY_RETENTION_DAYS", 30, { max: 3650 });
}

export function perUserCap(): number {
  return readPositiveInt("PROBE_HISTORY_PER_USER", 500, { max: 20_000 });
}

const MAX_QUERY = 400;
const MAX_SOURCES = 30;
const MAX_HOSTS = 20;
const MAX_DEGRADED = 20;

export function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase().slice(0, 120) || null;
  } catch {
    return null;
  }
}

function jsonList(value: unknown, cap: number): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const v = item.trim().slice(0, 200);
    if (!v || out.includes(v)) continue;
    out.push(v);
    if (out.length >= cap) break;
  }
  return out;
}

function parseJsonList(raw: unknown, cap: number): string[] {
  if (typeof raw !== "string" || !raw) return [];
  try {
    return jsonList(JSON.parse(raw), cap);
  } catch {
    return [];
  }
}

function num(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

/**
 * 写一条历史：主行 + 信源行在同一个事务里。
 * 返回 id；写不进去就抛（调用方决定是否吞掉）。
 */
export function saveQuery(input: NewQuery): string {
  const db = getDb();
  const now = Number.isFinite(input.now) ? Number(input.now) : Date.now();
  const id = cryptoRandomId();
  const query = storeQueryText() ? input.query.trim().slice(0, MAX_QUERY) : "";
  const sources = (input.sources ?? []).slice(0, MAX_SOURCES);
  const hosts: string[] = [];
  for (const s of sources) {
    const h = hostOf(s.url);
    if (h && !hosts.includes(h)) hosts.push(h);
    if (hosts.length >= MAX_HOSTS) break;
  }
  const expiresAt = now + retentionDays() * 86_400_000;

  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(
      `INSERT INTO queries (id, user_id, query, region, model_host, intent_kind, entities,
        summary_len, claims, supported, contradicted, unknown_n, degraded, source_n, source_hosts,
        doc_hash, elapsed_ms, created_at, expires_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      id,
      input.userId,
      query,
      input.region.slice(0, 16),
      input.modelHost ? input.modelHost.slice(0, 120) : null,
      input.intentKind ? input.intentKind.slice(0, 32) : null,
      JSON.stringify(jsonList(input.entities, 8)),
      num(input.summaryLen),
      num(input.claims),
      num(input.supported),
      num(input.contradicted),
      num(input.unknownN),
      JSON.stringify(jsonList(input.degraded, MAX_DEGRADED)),
      sources.length,
      JSON.stringify(hosts),
      input.docHash ? input.docHash.slice(0, 32) : null,
      num(input.elapsedMs),
      now,
      expiresAt,
    );

    const insertSource = db.prepare(
      "INSERT OR REPLACE INTO query_sources (query_id, idx, url, title, provider, quote_hash) VALUES (?,?,?,?,?,?)",
    );
    sources.forEach((s, i) => {
      insertSource.run(id, i, s.url.slice(0, 2_000), s.title ? s.title.slice(0, 300) : null, s.provider.slice(0, 24), s.quoteHash ? s.quoteHash.slice(0, 32) : null);
    });

    // 每人上限：插入后顺手把超出 cap 的最旧记录删掉。只删自己的，且一次最多删 5 条
    // （正常情况下一次只会超 1 条，删多了说明有人绕过入口在灌数据）。
    db.prepare(
      `DELETE FROM queries WHERE id IN (
         SELECT id FROM queries WHERE user_id = ? ORDER BY created_at DESC LIMIT -1 OFFSET ?
       )`,
    ).run(input.userId, perUserCap());

    db.exec("COMMIT");
    return id;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

function cryptoRandomId(): string {
  try {
    return globalThis.crypto.randomUUID();
  } catch {
    return hashText(String(Date.now()) + Math.random()) + Date.now().toString(36);
  }
}

function rowToHistory(r: Record<string, unknown>): HistoryRow {
  return {
    id: String(r.id ?? ""),
    query: typeof r.query === "string" ? r.query : "",
    at: num(r.created_at),
    region: typeof r.region === "string" ? r.region : "",
    intentKind: typeof r.intent_kind === "string" ? r.intent_kind : null,
    counts: {
      claims: num(r.claims),
      supported: num(r.supported),
      contradicted: num(r.contradicted),
      unknown: num(r.unknown_n),
    },
    degraded: parseJsonList(r.degraded, MAX_DEGRADED),
    sources: num(r.source_n),
    hosts: parseJsonList(r.source_hosts, MAX_HOSTS),
  };
}

export type ListOptions = { limit?: number; before?: number | null; q?: string | null };

/** 列表：游标分页（before = 严格小于它的 created_at）。只查自己的。 */
export function listQueries(userId: string, opts: ListOptions = {}): { items: HistoryRow[]; next: number | null } {
  const db = getDb();
  const limit = Math.min(Math.max(Math.floor(Number(opts.limit ?? 20) || 20), 1), 50);
  const before = Number.isFinite(opts.before) ? Number(opts.before) : null;
  const needle = typeof opts.q === "string" ? opts.q.trim().slice(0, 80) : "";

  const where: string[] = ["user_id = ?", "expires_at > ?"];
  const params: unknown[] = [userId, Date.now()];
  if (before !== null) {
    where.push("created_at < ?");
    params.push(before);
  }
  if (needle.length >= 2) {
    where.push("query LIKE ? ESCAPE '\\'");
    params.push("%" + needle.replace(/[%_\\]/g, (m) => "\\" + m) + "%");
  }

  const rows = db
    .prepare(
      `SELECT id, query, region, intent_kind, claims, supported, contradicted, unknown_n,
              degraded, source_n, source_hosts, created_at
         FROM queries WHERE ${where.join(" AND ")}
        ORDER BY created_at DESC LIMIT ?`,
    )
    .all(...params, limit + 1) as Record<string, unknown>[];

  const items = rows.slice(0, limit).map(rowToHistory);
  const next = rows.length > limit ? items[items.length - 1]?.at ?? null : null;
  return { items, next };
}

/** 单条详情。不是自己的返回 null（路由把它翻成 404，不用 403 —— 403 会泄露「这条存在」）。 */
export function getQuery(userId: string, id: string): HistoryDetail | null {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT id, query, region, intent_kind, claims, supported, contradicted, unknown_n,
              degraded, source_n, source_hosts, created_at, elapsed_ms
         FROM queries WHERE id = ? AND user_id = ?`,
    )
    .get(id, userId) as Record<string, unknown> | undefined;
  if (!row) return null;

  const sourceRows = db
    .prepare("SELECT url, title, provider, quote_hash FROM query_sources WHERE query_id = ? ORDER BY idx")
    .all(id) as Record<string, unknown>[];

  return {
    ...rowToHistory(row),
    elapsedMs: num(row.elapsed_ms),
    sourceRows: sourceRows.map((s) => ({
      url: String(s.url ?? ""),
      title: typeof s.title === "string" ? s.title : null,
      provider: String(s.provider ?? ""),
      quoteHash: typeof s.quote_hash === "string" ? s.quote_hash : null,
    })),
  };
}

export function deleteQuery(userId: string, id: string): boolean {
  const db = getDb();
  const res = db.prepare("DELETE FROM queries WHERE id = ? AND user_id = ?").run(id, userId);
  return Number(res.changes) > 0;
}

export function clearQueries(userId: string): number {
  const db = getDb();
  const res = db.prepare("DELETE FROM queries WHERE user_id = ?").run(userId);
  return Number(res.changes) || 0;
}

/** 过期清理。单次有上限，避免长事务把读请求堵住（由 cron/heat 顺带调）。 */
export function pruneExpired(limit = 500): number {
  const db = getDb();
  const res = db
    .prepare("DELETE FROM queries WHERE id IN (SELECT id FROM queries WHERE expires_at <= ? LIMIT ?)")
    .run(Date.now(), Math.max(1, Math.min(5_000, Math.floor(limit))));
  return Number(res.changes) || 0;
}

export function countQueries(userId: string): number {
  const db = getDb();
  const row = db.prepare("SELECT COUNT(*) AS n FROM queries WHERE user_id = ?").get(userId) as { n?: number } | undefined;
  return num(row?.n);
}

/** 后台「设置」用：总行数与库体积（字节）。 */
export function dbStats(): { rows: number; bytes: number } {
  const db = getDb();
  const rows = num((db.prepare("SELECT COUNT(*) AS n FROM queries").get() as { n?: number } | undefined)?.n);
  const pageCount = num((db.prepare("PRAGMA page_count").get() as { page_count?: number } | undefined)?.page_count);
  const pageSize = num((db.prepare("PRAGMA page_size").get() as { page_size?: number } | undefined)?.page_size);
  return { rows, bytes: pageCount * pageSize };
}

/**
 * 从 localStorage 导入（一次性）。服务端重算 region/model，不采信客户端：
 * 客户端能编造一个「境外」来让历史看起来像是在别的区域跑的。
 * 幂等口径：同一 user 下 (query, created_at 分钟级) 已存在就跳过。
 */
export function importQueries(
  userId: string,
  items: readonly { query: string; at?: number }[],
  ctx: { region: string; modelHost?: string | null },
): { imported: number; skipped: number } {
  const db = getDb();
  let imported = 0;
  let skipped = 0;
  const exists = db.prepare(
    "SELECT 1 AS ok FROM queries WHERE user_id = ? AND query = ? AND created_at >= ? AND created_at <= ? LIMIT 1",
  );

  for (const item of items.slice(0, 200)) {
    const q = String(item.query ?? "").trim().slice(0, MAX_QUERY);
    if (!q) {
      skipped += 1;
      continue;
    }
    const now = Date.now();
    const raw = Number(item.at);
    const at = Number.isFinite(raw) && raw > 0 && raw <= now ? Math.floor(raw) : now;
    const minute = 60_000;
    if (exists.get(userId, q, at - minute, at + minute)) {
      skipped += 1;
      continue;
    }
    saveQuery({ userId, query: q, region: ctx.region, modelHost: ctx.modelHost ?? null, intentKind: "import", now: at, sources: [] });
    imported += 1;
  }
  return { imported, skipped };
}
