/**
 * SQLite 适配层：全仓库**唯一** import node:sqlite 的地方。
 *
 * 为什么是 node:sqlite 而不是 better-sqlite3：
 *   - Node 22 内置，零依赖，不需要在每次 npm ci 时编译原生模块；
 *   - 服务器实测（Node v22.23.4）无需 --experimental-sqlite 即可 require，
 *     只打一行 ExperimentalWarning。
 * 对冲：所有 SQL 都从这里出去，万一将来 API 变了，换 better-sqlite3 只改这个文件
 * （两者都是 prepare().run/all/get 的形状）。
 *
 * 为什么另开一个库、不把 auth 的 store.json 搬进来：
 *   store.json 是「谁能登录」的真相，它的 serialize() 单链与 tmp+rename 写得很稳。
 *   为一个几百 KB 的文件做存储迁移，收益是零，风险是把登录押在一次重构上。
 */
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

import { migrate } from "./migrate";

type SqliteDb = {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
    all(...params: unknown[]): unknown[];
    get(...params: unknown[]): unknown;
  };
  close(): void;
};

export type Db = SqliteDb;

let cached: Db | null = null;

/** 库文件位置：与 store.json 同一个 PROBE_DATA_DIR，但另一个文件。 */
export function dbFile(): string {
  const dir = (process.env.PROBE_DATA_DIR || "").trim() || join(process.cwd(), ".data");
  return join(dir, "probe.db");
}

export function getDb(): Db {
  if (cached) return cached;
  const file = dbFile();
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });

  // 取内置模块不走 require/import 字面量：
  // 打包器会把 require("node:sqlite") 当成一个外部引用去解析，构建产物里变成
  //   Error: Cannot find module 'node:sqlite': Unsupported external type Url for commonjs reference
  // （2026-10-25 实测：npm test 与 tsc 全绿，next build 也绿，只有 next start 后一调接口就 500）。
  // process.getBuiltinModule 是 Node 22.3+ 的运行时 API，打包器看不见它，运行时照常拿到真模块。
  const getBuiltin = (process as unknown as { getBuiltinModule?: (id: string) => unknown }).getBuiltinModule;
  const mod = (typeof getBuiltin === "function" ? getBuiltin.call(process, "node:sqlite") : null) as
    | { DatabaseSync: new (path: string) => SqliteDb }
    | null;
  if (!mod) {
    throw new Error("当前 Node 没有 node:sqlite（需要 22.5+，且未加 --no-experimental-sqlite）。");
  }
  const db = new mod.DatabaseSync(file);

  // WAL：读写不互斥（读历史时不会被一次写入堵住）。
  db.exec("PRAGMA journal_mode = WAL");
  // NORMAL：掉电最多丢最后一个事务。历史不是账本，这个代价换每次写少一次 fsync。
  db.exec("PRAGMA synchronous = NORMAL");
  // 撞锁等 3 秒再报错，而不是把 SQLITE_BUSY 抛到用户脸上。
  db.exec("PRAGMA busy_timeout = 3000");
  // 外键默认是关的：不打开 ON DELETE CASCADE 就是摆设。
  db.exec("PRAGMA foreign_keys = ON");

  migrate(db);
  cached = db;
  return db;
}

/** 备份/演练用：把 WAL 合并进主文件，之后只需拷一个文件。 */
export function checkpoint(): void {
  try {
    getDb().exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } catch {
    // 库还不存在（或只读）时 checkpoint 会失败：备份脚本自己会判断文件在不在。
  }
}

export function __testCloseDb(): void {
  try {
    cached?.close();
  } catch {
    // 已关闭
  }
  cached = null;
}
