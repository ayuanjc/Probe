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
  // v3：实体追踪（公司 / 技术在热榜里的时间线，公开可看）
  //
  // 与 watch_hits 的区别：watch_hits 是「某个人关注了谁」（一行绑一个 user_id），
  // entity_hits 是「词典里的实体今天被谁提到」（没有人，全公开）。所以这里**没有 user_id**，
  // 也不能从它反推任何人的行为。
  //
  // 只存索引：标题 + 链接 + 来源 + 热度 + 时间。正文不存。
  // UNIQUE(entity_key, url)：同一条新闻只算一次，cron 每半小时跑一遍不会把时间线刷满。
  `
CREATE TABLE entity_hits (
  id         TEXT PRIMARY KEY,
  entity_key TEXT NOT NULL,
  name       TEXT NOT NULL,
  kind       TEXT NOT NULL DEFAULT 'other',
  url        TEXT NOT NULL,
  title      TEXT NOT NULL,
  host       TEXT,
  provider   TEXT,
  points     INTEGER NOT NULL DEFAULT 0,
  seen_at    TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE(entity_key, url)
);
CREATE INDEX idx_entity_hits_key_time ON entity_hits(entity_key, created_at DESC);
CREATE INDEX idx_entity_hits_time     ON entity_hits(created_at DESC);
  `,
  // v4：把「事件发生/发布的时间」和「我们什么时候抓到」分开。
  //
  // 为什么要分开：时间线是按时间读的。原来 at 取 created_at（cron 落库那一刻），
  // 于是同一轮抓到的三条 HN / 百度 / IT之家 全都同一个时间戳 —— 跨度恒为 0，
  // 排出来的顺序其实是插入顺序。三天前的旧闻今天才被抓到，也会被排在今天。
  //
  // 上游给了发布时间就用它（pub_at），没给（掘金、少数派以外的榜单）就退回 created_at。
  // 两条都留着，不覆盖任何一个：事后能分辨「这是旧闻」还是「这是新发现」。
  `
ALTER TABLE entity_hits ADD COLUMN pub_at INTEGER;
UPDATE entity_hits SET pub_at = created_at WHERE pub_at IS NULL OR pub_at <= 0;
CREATE INDEX idx_entity_hits_key_pub ON entity_hits(entity_key, pub_at DESC);
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
