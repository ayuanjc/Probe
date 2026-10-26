/**
 * 库结构迁移。
 *
 * 只允许「加表 / 加索引」；改字段要新写一步（重建表 + 拷数据），
 * 因为自动部署每 5 分钟就会用新代码打开旧库，任何一步半成品都是线上事故。
 *
 * 版本号用 SQLite 自带的 PRAGMA user_version：不额外建表，也不会因为
 * 「表建了但写了一半」而误判。
 */
export type MigratableDb = {
  exec(sql: string): void;
  prepare(sql: string): { get(...params: unknown[]): unknown };
};

export const MIGRATIONS: string[] = [
  // v1：账号级历史（queries + query_sources）
  `
CREATE TABLE queries (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  query        TEXT NOT NULL,
  region       TEXT NOT NULL,
  model_host   TEXT,
  intent_kind  TEXT,
  entities     TEXT,
  summary_len  INTEGER NOT NULL DEFAULT 0,
  claims       INTEGER NOT NULL DEFAULT 0,
  supported    INTEGER NOT NULL DEFAULT 0,
  contradicted INTEGER NOT NULL DEFAULT 0,
  unknown_n    INTEGER NOT NULL DEFAULT 0,
  degraded     TEXT,
  source_n     INTEGER NOT NULL DEFAULT 0,
  source_hosts TEXT,
  doc_hash     TEXT,
  elapsed_ms   INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL
);
CREATE INDEX idx_queries_user_time ON queries(user_id, created_at DESC);
CREATE INDEX idx_queries_expiry    ON queries(expires_at);
CREATE TABLE query_sources (
  query_id   TEXT NOT NULL REFERENCES queries(id) ON DELETE CASCADE,
  idx        INTEGER NOT NULL,
  url        TEXT NOT NULL,
  title      TEXT,
  provider   TEXT NOT NULL,
  quote_hash TEXT,
  PRIMARY KEY (query_id, idx)
);
  `,
  // v2：关注实体与命中（P1 关注实体回流）
  //
  // 存什么的口径与 queries 一致：只存索引（标题、URL、来源 host、points、时间），
  // 不存正文、不存模型输出。标题留着是因为「命中」这件事脱离标题就说不清 ——
  // 用户点开要看到「它当时说的是这句」，而不是一个光秃秃的 URL。
  //
  // watch_hits 的 UNIQUE(watch_id, url)：同一条新闻只算一次命中，重复跑 cron 不会刷屏。
  // 两个索引分别服务「我的未读」（user_id, read_at）与「某个关注的历史」（watch_id, created_at）。
  `
CREATE TABLE watches (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  name         TEXT NOT NULL,
  key          TEXT NOT NULL,
  aliases      TEXT NOT NULL,
  kind         TEXT NOT NULL DEFAULT 'other',
  created_at   INTEGER NOT NULL,
  UNIQUE(user_id, key)
);
CREATE TABLE watch_hits (
  id         TEXT PRIMARY KEY,
  watch_id   TEXT NOT NULL REFERENCES watches(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL,
  url        TEXT NOT NULL,
  title      TEXT,
  host       TEXT,
  provider   TEXT,
  points     INTEGER NOT NULL DEFAULT 0,
  seen_at    TEXT,
  created_at INTEGER NOT NULL,
  read_at    INTEGER,
  UNIQUE(watch_id, url)
);
CREATE INDEX idx_watch_hits_user_read ON watch_hits(user_id, read_at);
CREATE INDEX idx_watch_hits_watch     ON watch_hits(watch_id, created_at DESC);
  `,
];

export function currentVersion(db: MigratableDb): number {
  const row = db.prepare("PRAGMA user_version").get() as { user_version?: number } | undefined;
  const v = Number(row?.user_version ?? 0);
  return Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0;
}

export function migrate(db: MigratableDb): void {
  const from = currentVersion(db);
  if (from > MIGRATIONS.length) {
    // 库比代码新：说明回滚到了旧版本。静默当空库会写坏数据，直接拒。
    throw new Error("probe.db 的结构版本是 " + from + "，比当前代码认识的 " + MIGRATIONS.length + " 还新");
  }
  for (let v = from; v < MIGRATIONS.length; v += 1) {
    db.exec("BEGIN");
    try {
      db.exec(MIGRATIONS[v]);
      db.exec("PRAGMA user_version = " + (v + 1));
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
}
