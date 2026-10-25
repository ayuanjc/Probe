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
