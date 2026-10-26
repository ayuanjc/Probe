# b2 设计方案：账号级历史 · 关注实体回流 · 结果分享

> 状态：设计稿（未实施）。写这份的目的不是「拍脑袋加功能」，而是在**动数据之前**把
> 「存什么、存哪、谁能读、多久删、备案要不要变更」全部想清楚 —— 这个项目从第一天起
> 就只有两样资产：**信源可信** 和 **不撒谎**。加一个数据库，风险全在「悄悄多存了一堆东西」。

---

## 0. 一句话结论

用 **SQLite（Node 22 内置 `node:sqlite`，零依赖）** 建一个**只放新域数据**的库 `.data/probe.db`，
auth 那份 `store.json` **不动**。三件事分三阶段做，每阶段都能单独上线、单独回滚：

| 阶段 | 内容 | 改动面 | 破不破「零数据库」 | 备案影响 |
| --- | --- | --- | --- | --- |
| P0 账号级历史 | 提问记录上云，换设备能看到 | 小（新增 1 表 + 2 接口） | 破（但只存自己的 query） | 首次备案期**可以做**，隐私政策加一段 |
| P1 关注实体回流 | 关注实体，热榜命中时提示 | 中（2 表 + 1 个定时任务 + 后台） | 不额外破 | 可以做 |
| P2 结果分享 | 生成只读分享链接 | 中大（2 表 + 公开读接口 + OG 图） | 破得更彻底 | **首次备案期不能做** —— 见第 11 节，这属于用户生成内容（UGC） |

我的建议：**P0 现在做，P1 备案通过后做，P2 等你有企业主体 + 想清楚要不要做社区再说**。
如果你要「全都要」，第 17 节给了完整文件清单，第 19 节列了为什么某些做法我不建议。

---

## 1. 你的设想（我按这个约束来设计）

从产品定位反推出来的硬约束，设计里一条都没违反：

| 你的原则 | 在设计里的落点 |
| --- | --- |
| 不撒谎：每个数字点得回原文 | 历史/分享**只存结构与引用**，永不存「二手数字」；打开分享页时数字仍指向原始 URL，不指向我们的副本 |
| 面向 Geek，不是内容社区 | 分享页**默认 `noindex`**、无评论、无点赞、无公开列表、无推荐流。它是一张「截图链接」，不是一个广场 |
| 邀请制、小规模 | 不需要分库分表、不需要 Redis、不需要连接池；单进程 + SQLite WAL 足够撑到日活几千 |
| 零依赖洁癖 | P0/P1/P2 全部**零新依赖**（`node:sqlite` 是 Node 内置） |
| 备案期别惹事 | 分阶段，最容易被认定成「社区」的分享功能放到最后，且默认关闭 |

反过来，明确**不做**的（这些一做就变味）：

- 不做「发现」页、不做热门分享榜、不做别人的历史能被搜到。
- 不做用户头像/昵称/简介 —— 分享页只标 `由邀请用户分享`，不暴露是谁。
- 不做把正文/模型输出落库当缓存（正文一律回源，或只存 hash + URL）。

---

## 2. 现状盘点（改之前必须知道的事实）

全部核对过 `src/`，不是推测：

| 现状 | 位置 | 对设计的影响 |
| --- | --- | --- |
| 历史只活在该浏览器 | `src/lib/history.ts`，localStorage，注入式存储便于测试，单条 `query` 截 400 字 | P0 要写「导入 + 双写 + 以服务端为准」的迁移，不能一刀切 |
| 唯一的持久化是 `store.json` | `src/lib/auth/store.ts`，`PROBE_DATA_DIR`（默认 `./.data`），0600，写 tmp 再 rename，`serialize()` 单 Promise 链 | 新库**不复用**它：一次写全量文件的做法不适合按行追加的历史 |
| 会话是 HttpOnly cookie | `src/lib/auth/session.ts`，`probe_session`，TTL 168h，Lax，https 时加 Secure | 分享页必须**不要求**这个 cookie（匿名可读），所以它在鉴权模型之外 |
| 用户量很小 | 无 `users` 表，`store.json` 里一个数组 | 不需要外键约束的复杂度，但**仍然建外键**，防手滑 |
| SSE 是搜索的主通道 | `src/app/api/search/route.ts` + `src/lib/sse.ts` + `src/hooks/useProbe.ts` | 历史写入点必须挂在 `done` 事件之后，且**不能**因为写库失败把用户已经看到的答案弄坏 |
| 已有实体词典 | `src/lib/entities.ts`（中英别名、EN_ALIAS、按 query 命中 org/tech/person/geo） | P1 的关注对象直接复用，不自造一套 |
| 已有热榜 | `src/lib/trending.ts`（GDELT/HN）+ `src/lib/heat-history.ts`（`PROBE_DATA_DIR/.cache/hn-history.json`）+ `src/app/api/cron/heat` | P1 的「回流」挂在 cron/heat 上，不新开定时器 |
| 已有额度闸 | `src/lib/llm.ts`：`OP_UNITS`、`chargeOperation`、全局 `PROBE_DAILY_LLM_CALLS=800`、按人 `PROBE_DAILY_LLM_UNITS_PER_USER=60` | P1 若要用模型判断「这条热榜是否真的讲到了我关注的实体」，**必须记点**，否则一个人能烧穿全员额度 |
| 已有错误账本 | `src/lib/error-log.ts` + 后台「设置」 | 新接口沿用 `jsonError()`，5xx 自动进账本，**不额外造观测** |
| 已有备份 | `scripts/server/backup-probe.sh`，每天 03:20，打 `probe-YYYYmmdd-HHMMSS.tar.gz`，校验 store.json 合法 JSON | P0 必须同步改备份与恢复流程，否则历史「有但恢复不回来」 |
| 部署是每 5 分钟自动拉 main | `scripts/server/update.sh` + `probe-update.timer`，替换前 `rm -rf src scripts tests docs public` | **`.data/` 在删除范围之外**（保留），所以新库文件天然能活过部署；但也意味着**迁移脚本必须幂等**（旧的库结构会在某次自动部署后遇到新代码） |
| 站点当前状态 | 备案阶段：`probe-temp-open` 生效（裸 IP 可访问，Host 头被云侧阻断） | P2 的公开分享页在「未备案也能被外网访问」的当下等于**把 UGC 挂到裸 IP 上**，风险最大 |

一个容易忽略的点：**Next 的 route handler 会被并发调用，但 Node 进程只有一个**。SQLite 的写锁足够，
前提是 `busy_timeout` 设好、且写事务短（毫秒级）。第 5 节的 DDL 与第 6 节的写点都是按「单条写、不批量扫」设计的。

---

## 3. 存储选型

### 3.1 实测过的事实（不是查文档）

```
$ /opt/node/bin/node -e "require('node:sqlite')"
node:sqlite OK DatabaseSync,StatementSync,constants,backup
(node:1355169) ExperimentalWarning: SQLite is an experimental feature and might change at any time
```

- 服务器 Node **v22.23.4**，`node:sqlite` **无需 `--experimental-sqlite`** 即可 require，只打一行 ExperimentalWarning。
- 导出的 API：`DatabaseSync`（同步）、`StatementSync`（预处理语句）、`backup`（在线热备）。
- 机器上有 `g++ / make / python3`（万一以后要换 `better-sqlite3` 也能编译）。

### 3.2 候选对照

| 方案 | 追加写 | 查询 | 依赖 | 迁移成本 | 结论 |
| --- | --- | --- | --- | --- | --- |
| 继续用 JSON 文件（每个用户一个） | 读全量→改→写全量，1000 条后每次写完 200KB | 只能扫 | 零 | 低 | ✗ 用户一多就变成「每次提问写 200KB」 |
| **`node:sqlite`（推荐）** | 单行 INSERT，微秒级 | SQL + 索引 | **零**（Node 内置） | 中 | ✓ |
| `better-sqlite3` | 同上，更快 | 同上 | 原生编译（每次 npm ci 都要编译） | 中 | 备选：若 `node:sqlite` 在某次 Node 大版本变更 API，换它只需改一层适配（第 3.4） |
| Postgres | 同上 | 更强 | 装服务 + 连接池 + 备份另一套 | 高 | ✗ 单机 2 核 4G，为一个几百 MB 的库装 PG 是负债 |
| Redis | 同上 | 弱（无查询） | 装服务 | 中 | ✗ 只在「多进程共享限流」时才值得（b6 实测单进程够用，见 13.1），与 b2 无关 |
| 对象存储（COS） | — | — | 网络往返 | 中 | ✗ 历史要按用户分页查，走对象存储等于自己写一个数据库 |

### 3.3 为什么新开一个库，而不是把 auth 也搬进 SQLite

`store.json` 目前是**认证的真相**：`serialize()` 单链保证「读-改-写」原子，`writeStore()` 先写 tmp 再 rename，
坏文件时抛 `store_corrupt` 而**不**当空库（否则会重种管理员）。这套逻辑写得很好，动它等于把「谁能登录」
押在一次重构上，收益却是零（`store.json` 现在几百 KB，读写都不是瓶颈）。

**决策：`store.json` 不动。新库只放 history / watch / share。** 将来真要合并，也是先写双写层再切读，不在这轮。

### 3.4 适配层（唯一允许 import sqlite 的地方）

```ts
// src/lib/db/index.ts —— 全仓库唯一 import node:sqlite 的文件
export type Db = import("node:sqlite").DatabaseSync;

let db: Db | null = null;

export function getDb(): Db {
  if (db) return db;
  const file = dbFile();            // PROBE_DATA_DIR/.data 以外的同一处：PROBE_DATA_DIR/probe.db
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const d = new DatabaseSync(file);
  d.exec("PRAGMA journal_mode = WAL");      // 读写不互斥；WAL 文件跟着库一起备份
  d.exec("PRAGMA synchronous = NORMAL");    // 掉电最多丢最后一个事务，可接受（历史）
  d.exec("PRAGMA busy_timeout = 3000");     // 撞锁等 3s 再报错，别抛给用户
  d.exec("PRAGMA foreign_keys = ON");       // 默认是关的，不打开则级联删除不生效
  migrate(d);                                // 幂等迁移，见第 5.3
  db = d;
  return d;
}

export function __testCloseDb() { db?.close(); db = null; }
```

要点：

- **同步 API**（`DatabaseSync`）在 Next 的 route handler 里可以直接用 —— 单条 INSERT 是微秒级，
  阻塞事件循环的时间远小于一次 `await fetch` 的调度开销。**但禁止**在这里跑「扫全表」的查询（第 6 节有分页上限）。
- `import("node:sqlite")` 写成类型导入，运行时的 require 交给 `getDb()`，这样 **`npm test` 与 `next build` 不会因为实验性警告失败**。
- 实验性 API 的风险对冲：所有 SQL 都过适配层，换 `better-sqlite3` 只改这一个文件（API 形状几乎一致：`prepare().run/all/get`）。

---

## 4. 文件布局与运维

```
/opt/probe/app/.data/
├── auth/store.json          ← 不动
├── probe.db                 ← 新（0600）
├── probe.db-wal             ← WAL，写入时存在
├── probe.db-shm             ← WAL 共享内存
├── ops/limits.json          ← 不动
└── consent/consent.log      ← 不动
```

| 事项 | 口径 |
| --- | --- |
| 权限 | 库文件与目录 `0600 / 0700`（与 store.json 同口径）；WAL 文件由 SQLite 建，继承目录权限 |
| 备份 | `backup-probe.sh` 用 `sqlite3 probe.db ".backup /tmp/x.db"` 之外的做法：Node 里 `db.backup(path)`；脚本里没有 sqlite3 CLI 就用 `cp` 全部三个文件（WAL 未合并也能恢复，但须一起拷）。**推荐**：备份前跑一次 `PRAGMA wal_checkpoint(TRUNCATE)` 再拷单个文件 |
| 恢复 | 停 `probe-web` → 放回 `probe.db` → 删掉残留 `-wal/-shm`（否则 SQLite 会尝试回放旧 WAL）→ 起服务 → `GET /api/health/db` 断言表与行数 |
| 体积预估 | 一条历史 1–3KB（query + 结构引用），1 万人各 500 条约 5–15GB；实际邀请制几十人 → 几十 MB。**上限**见第 13 节 |
| 迁移幂等 | `.data/` 不在部署删除范围内，所以**旧库会在新代码下被打开**；`migrate()` 用 `PRAGMA user_version` 递增，每步单独事务 |
---

## 5. 数据模型

### 5.1 设计原则

1. **只存「我看到了什么」的索引，不存「内容本身」**：query、面板结构、断言引用（url + quote 的 hash）、时间。
   正文与模型输出不落库 —— 落库就等于我们成了一个内容托管方，风险与成本都翻倍。
2. **每条记录都能被用户一键删掉**（`ON DELETE CASCADE`），因为隐私政策里要能写「你可以删除」。
3. **保留期是字段而不是约定**：`expires_at` 由写入时算好，清理任务照它删。
4. 所有时间用 **整数毫秒**（与仓库里 `Date.now()` 口径一致），不用 SQLite 的 TEXT 时间。

### 5.2 DDL（v1）

```sql
-- ---------- P0：账号级历史 ----------
CREATE TABLE queries (
  id           TEXT PRIMARY KEY,          -- crypto.randomUUID()
  user_id      TEXT NOT NULL,             -- 对应 store.json 里的 user.id（不建外键到不存在的表）
  query        TEXT NOT NULL,             -- 已 trim + slice(0,400)，与 /api/search 同口径
  region       TEXT NOT NULL,             -- 'cn' | 'intl'（同一句话在不同区域结果不同，这条要留证据）
  model_host   TEXT,                      -- 记录当时用的是哪个端点（换模型后回看才知道为什么答案变了）
  intent_kind  TEXT,                      -- 'lookup' | 'compare' | ...（来自 intent 事件）
  entities     TEXT,                      -- JSON：实体名数组，只留名字不留 id
  summary_len  INTEGER NOT NULL DEFAULT 0,-- 摘要字数（不存摘要正文）
  claims       INTEGER NOT NULL DEFAULT 0,-- 断言条数
  supported    INTEGER NOT NULL DEFAULT 0,-- 判成「支持」的条数
  contradicted INTEGER NOT NULL DEFAULT 0,
  unknown_n    INTEGER NOT NULL DEFAULT 0,
  degraded     TEXT,                      -- JSON：降级原因码数组（llm:user_budget 等），给「为什么这次结果薄」留证据
  source_n     INTEGER NOT NULL DEFAULT 0,
  source_hosts TEXT,                      -- JSON：域名去重数组（最多 20 个），不存 URL 与正文
  doc_hash     TEXT,                      -- 文档核验才有：sha256(正文).slice(0,16)，正文本身不落库
  elapsed_ms   INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL,          -- Date.now()
  expires_at   INTEGER NOT NULL           -- 默认 created_at + 90 天
);
CREATE INDEX idx_queries_user_time ON queries(user_id, created_at DESC);
CREATE INDEX idx_queries_expiry    ON queries(expires_at);

-- 单条历史里被引用到的信源（分享页与「回到原文」用）
CREATE TABLE query_sources (
  query_id   TEXT NOT NULL REFERENCES queries(id) ON DELETE CASCADE,
  idx        INTEGER NOT NULL,            -- 面板里的顺序，稳定排序用
  url        TEXT NOT NULL,               -- 原始 URL（可点回原文）
  title      TEXT,
  provider   TEXT NOT NULL,               -- bocha | tavily | wiki | hn | gdelt | fixture
  quote_hash TEXT,                        -- sha256(quote).slice(0,16)：能验「同一条引文」但不留原文
  PRIMARY KEY (query_id, idx)
);

-- ---------- P1：关注实体回流 ----------
CREATE TABLE watches (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  name       TEXT NOT NULL,               -- 规范化后的实体名（对齐 entities.ts 的 en 主名）
  kind       TEXT,                        -- org | tech | person | geo | other
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER,                   -- 上次命中时间（列表排序 + 去重提示用）
  UNIQUE (user_id, name)
);
CREATE INDEX idx_watches_user ON watches(user_id, created_at DESC);

CREATE TABLE watch_hits (
  id         TEXT PRIMARY KEY,
  watch_id   TEXT NOT NULL REFERENCES watches(id) ON DELETE CASCADE,
  title      TEXT NOT NULL,
  url        TEXT NOT NULL,
  provider   TEXT NOT NULL,               -- 命中来自哪个榜（gdelt/hn/wiki...）
  score      REAL,                        -- 相关度（0–1，来自标题/摘要的匹配强度，非模型置信度）
  seen_at    INTEGER NOT NULL,
  read_at    INTEGER,                     -- 用户点开过就置位（未读数 = count(read_at IS NULL)）
  UNIQUE (watch_id, url)                  -- 同一条新闻不重复推
);
CREATE INDEX idx_hits_watch ON watch_hits(watch_id, seen_at DESC);

-- ---------- P2：结果分享 ----------
CREATE TABLE shares (
  token       TEXT PRIMARY KEY,           -- 32 字节随机 → base64url(43 字符)
  query_id    TEXT NOT NULL REFERENCES queries(id) ON DELETE CASCADE,
  owner_id    TEXT NOT NULL,
  title       TEXT,                       -- 分享者可以改标题，默认用 query
  redact      INTEGER NOT NULL DEFAULT 1, -- 1 = 去掉 query 原文（只留面板）
  expires_at  INTEGER,                    -- NULL = 不过期（默认给 30 天）
  revoked_at  INTEGER,
  views       INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);
CREATE INDEX idx_shares_owner ON shares(owner_id, created_at DESC);
CREATE INDEX idx_shares_query ON shares(query_id);

-- ---------- 埋点（最小口径，不是全量埋点） ----------
CREATE TABLE events (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  at       INTEGER NOT NULL,
  name     TEXT NOT NULL,                 -- search.done | verify.done | share.view | watch.hit ...
  user_id  TEXT,                          -- 匿名事件为 NULL
  region   TEXT,
  props    TEXT,                          -- JSON，白名单字段，禁止自由塞
);
CREATE INDEX idx_events_at ON events(at);
```

### 5.3 迁移（幂等，必须能在旧库上跑）

```ts
// src/lib/db/migrate.ts
const MIGRATIONS: string[] = [ /* 上面那段 DDL 拆成语句数组，v1 */ ];

export function migrate(db: Db) {
  const cur = Number((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version ?? 0);
  for (let v = cur; v < MIGRATIONS.length; v += 1) {
    db.exec("BEGIN");
    try {
      db.exec(MIGRATIONS[v]);
      db.exec("PRAGMA user_version = " + (v + 1));
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;   // 迁移失败就别起服务：半套表比不起更糟
    }
  }
}
```

为什么 `PRAGMA user_version` 而不是自己建 `schema_migrations` 表：版本号是 SQLite 的内置元数据，
不需要额外事务，也不会因为「表存在但写了一半」而误判。迁移**只允许加表/加索引**，改字段要写第 v2 步（重建表 + 拷数据）。

---

## 6. 写入点与事务边界

### 6.1 搜索：挂在 `done` 之后，写失败不影响已上屏的答案

```ts
// src/app/api/search/route.ts（SSE start() 内，for-await 结束、yield done 之前）
try {
  saveQuery({
    userId: scope.key.slice(2),          // scope.key 形如 "u:<id>"
    query: input.query,
    region: summary.region,
    modelHost: summary.modelHost,
    intentKind: collected.intent?.kind ?? null,
    entities: collected.entities,
    claims: collected.claims.length,
    supported: ..., contradicted: ..., unknownN: ...,
    degraded: collected.degraded,
    sources: collected.sources,          // 只取 url/title/provider/quote 的 hash
    elapsedMs: Date.now() - startedAt,
  });
} catch (err) {
  // 历史是「附加价值」，不是主流程：写不进去也不许把这一轮弄成失败
  console.warn("[history] write failed", publicMessage(err, "历史未保存"));
}
```

三条硬规矩：

1. **只写一次**：SSE 重连、客户端重跑、同一 query 重复提交，都各自是一条历史（但 `events` 里记 `search.start` 可以对账）。
   不做「去重合并」—— 用户重跑一次往往就是想要新结果，把它藏起来才是撒谎。
2. **单事务**：`queries` 一行 + `query_sources` N 行（N ≤ 30）放在一个 `BEGIN IMMEDIATE ... COMMIT` 里，
   避免出现「有历史、没信源」的半条记录。
3. **不在 SSE 的 `push` 里写库**：写库发生在流结束之后，否则慢库会拖慢首屏。

### 6.2 文档核验：同样一个 `saveQuery`，`intent_kind = 'verify'`

核验没有「摘要」，但有一组分数（外部吻合度、内部一致、覆盖面）。字段复用：
`claims/supported/contradicted/unknown_n` + `degraded` 都有意义；`summary_len = 0`。
核验的 `query` 存**文档标题**（不是正文），正文只留 `doc_hash = sha256(正文).slice(0,16)` —— 这样「同一篇文档核验过」
能被识别，而文档内容不进我们的库。为此 `queries` 有一列 `doc_hash TEXT`（第 5.2 的 DDL 里已经包含）。

### 6.3 关注命中：由 `cron/heat` 顺带跑，不新开定时器

`/api/cron/heat` 现在每次跑：拉 GDELT/HN → 写 `hn-history.json` → 返回。P1 在这之后加一步：

```
1. 取所有 watch（去重后的 name 集合，通常几十个）
2. 对每个候选条目（每轮最多 300 条），用 entities.ts 的词典匹配标题（纯本地、零成本）
3. 命中 → INSERT OR IGNORE INTO watch_hits（UNIQUE(watch_id,url) 天然去重）
4. 只有「需要判断这条是否真的相关」时才调模型，且严格按 OP_UNITS 记点（见 9.3）
```

### 6.4 分享访问：只加计数，不做指纹

`share.view` 事件只写 `{ name: "share.view", at, region }`，**不写 IP、不写 UA、不写 referer**。
`shares.views` 自增用 `UPDATE shares SET views = views + 1 WHERE token = ?`（单语句原子）。

---

## 7. API 契约

统一沿用现有约定：`isCrossSite` → `requireUser` → `createLimiter` → `readJsonBody` → `jsonError`（5xx 自动进错误账本）。

### 7.1 P0 历史

| 方法与路径 | 用途 | 限流 | 说明 |
| --- | --- | --- | --- |
| `GET /api/history?limit=20&before=<ts>&q=<子串>` | 分页列表 | `PROBE_HISTORY_RATE_PER_MIN` 默认 60 | 只返回 `user_id = 自己`；`limit` 夹到 1–50；`before` 是游标（毫秒，严格小于）；`q` 只在**自己的**历史里 LIKE，长度 ≥2 |
| `GET /api/history?id=<id>` | 单条详情（含 sources）。**实现时改成了扁平路径**：仓库此前一条带动态段的 API 路由都没有，为 CRUD 引一个新约定不值 | 同上 | 不是自己的 → **404**（不是 403：403 会泄露「这条存在」） |
| `DELETE /api/history?id=<id>` | 删一条（同上，扁平；无 id 时要求 body `{"confirm":"DELETE"}` 才清空全部） | 同上 | 级联删 sources；返回 `{ok:true}`（幂等） |
| `DELETE /api/history` | 清空自己的 | 每分钟 2 次 | 需带 `{ confirm: "DELETE" }`，防 CSRF 误点 |
| `POST /api/history/import` | 导入 localStorage 历史 | 每分钟 2 次 | body：`{ items: [{query, at}] }`，最多 200 条、每条 ≤400 字；**服务端**重算 region/model，不采信客户端 |
| `GET /api/history/export` | 导出自己的全部（JSON） | 每分钟 2 次 | 上限 500 条；这是「用户有权导出」的落点（个人信息保护法第 45 条可携带） |

响应形状（列表）：

```json
{ "ok": true, "items": [
  { "id": "…", "query": "…", "at": 1761400000000, "region": "cn",
    "counts": { "claims": 6, "supported": 4, "contradicted": 1, "unknown": 1 },
    "degraded": ["claims:quote_miss_2"], "sources": 5, "hosts": ["reuters.com","…"] } ],
  "next": 1761390000000 }
```

### 7.2 P1 关注

| 方法与路径 | 用途 | 说明 |
| --- | --- | --- |
| `GET /api/watch` | 我的关注 + 未读命中数 | 返回 `[{ name, kind, hits: n, unread: m, lastSeenAt }]` |
| `POST /api/watch` | 加关注 | `{ name, kind? }`；名字走 `entities.ts` 的规范化；每人上限 50 个；重复添加返回已有那条（幂等） |
| `DELETE /api/watch?id=<id>` | 取关（P1，尚未实现；实施时同样走扁平路径） | 级联删 hits |
| `POST /api/watch/read` | 标记已读 | `{ ids: [hitId] }`，最多 200 个 |
| `GET /api/watch/hits?watch=<id>&limit=20` | 命中列表 | 分页同历史 |

### 7.3 P2 分享

| 方法与路径 | 用途 | 鉴权 | 说明 |
| --- | --- | --- | --- |
| `POST /api/share` | 由一条历史生成分享 | 需登录 | `{ queryId, title?, redact?, ttlDays? }`；`ttlDays` 夹到 1–90，默认 30；每人上限 100 条有效分享 |
| `GET /api/share` | 我的分享列表 | 需登录 | 含 token、views、expiresAt |
| `DELETE /api/share/[token]` | 撤销 | 仅 owner | 置 `revoked_at`（不物理删，防「撤了还能被人从缓存打开」的错觉——实际行为是立即 410） |
| `GET /s/[token]` | **公开只读页** | 无 | `noindex`；`revoked/expired` → 410 页面；每次访问 `views+1` |
| `GET /s/[token]/og` | 分享卡图 | 无 | `next/og`，动态生成 1200×630，只画标题 + 三色统计，不含模型输出 |

分享页的**内容边界**（这是整个设计里最要紧的一条）：

```
显示：query（redact=0 时）/ 面板结构 / 每条断言的状态与理由 / 原始信源链接 / 「由邀请用户分享」/ 分享时间
不显示：分享者的用户名、其它历史、IP、任何模型原文长段落（摘要最多 500 字，且标注「模型生成」）
```
---

## 8. P0 账号级历史（细节）

### 8.1 前端从「localStorage 是真相」变成「服务端是真相，本地是缓存」

现在的 `src/lib/history.ts` 是注入式存储（`readHistory / writeHistory / mergeHistory`，`parseHistory` 会 trim+slice 400），
`/api/search` 的路由不认识它，历史完全由浏览器自己记。改造三步，**第三步之前任何一步都能单独上线**：

| 步骤 | 行为 | 回滚 |
| --- | --- | --- |
| S1 双写 | 服务端写库（第 6 节）+ 前端继续写 localStorage | 关闭 `PROBE_HISTORY_SERVER=0`，服务端停止写，前端无感 |
| S2 首启导入 | 打开站点时若 `localStorage` 有、服务端为空 → `POST /api/history/import` 一次，成功后打标记 `probe:history:migrated=1` | 标记可直接手删；导入接口幂等（同 user+query+at 分钟级去重） |
| S3 读切换 | 侧栏历史改为 `GET /api/history`，localStorage 退化成「离线兜底」（失败时仍显示本地副本并标注「离线副本」） | 前端开关 `PROBE_HISTORY_UI=server` / `local` |

**为什么不是一次性切**：用户在旧浏览器里有历史，一刀切会让它凭空消失 —— 对一个「不撒谎」的产品，
「你的历史不见了」比「历史多存了一份」严重得多。

### 8.2 侧栏与页面的落点

- 侧栏（`src/components/Sidebar*` 或现有的历史列表）：分组「今天 / 昨天 / 更早」，每条右侧显示 `4/1/1` 三色小点
  （支持/矛盾/无法判定），超过 90 天的自动消失（不是灰掉 —— 灰掉会让人以为能点开）。
- 点一条历史 → **不开新窗口**，直接把当时的 query 回填到搜索框并允许「重跑」；
  要看当时的面板则进 `/history/[id]`（只读视图，复用 `Workspace` 的只读渲染，禁止触发新请求）。
- `/account` 加一块「我的历史」：条数、占用、**导出**、**清空**（带二次确认输入 `DELETE`）。

### 8.3 清理与配额

| 项 | 值 | 理由 |
| --- | --- | --- |
| 单条保留 | 90 天（`expires_at`） | 情报类内容的「三个月」足以回看，再久就是负担 |
| 每人上限 | 500 条（超出删最旧，写入时顺手删同用户第 501 条） | 防止一个人用 5 万条把库撑爆 |
| 每条尺寸 | `query` ≤400 字、`sources` ≤30 条、`source_hosts` ≤20、`degraded` ≤20 码 | 与 `/api/search` 的入参上限对齐 |
| 全局清理 | `cron/heat` 每次顺带 `DELETE FROM queries WHERE expires_at < now`（限 500 行/次，避免长事务） | 不新开定时器；单次删除有上限，永不长锁库 |

---

## 9. P1 关注实体回流（细节）

### 9.1 为什么这件事值得做

探针的核心价值是「你问它答」，而 Geek 的真实需求是「我没问，但它在动」。关注实体是唯一能实现
**被动回流**的功能：你关注「台积电」，热榜里出现相关新闻时，侧栏亮一个点。它不需要推荐算法，只需要词典 + 去重。

### 9.2 实体从哪来（三个入口，优先级从高到低）

1. **结果的实体**：每次 search 的 `intent.entities` 已经在屏幕上，旁边加一个「关注」小按钮（一次点击，零输入）。
2. **手输**：`/account` 一个输入框，走 `entities.ts` 的 `normalize`，命中词典则带 `kind`，否则 `other`。
3. **历史挖掘**：`GET /api/watch/suggest` 从自己最近 200 条历史的 `entities` 里按出现次数给出前 5 个建议 —— 只建议，不自动关注。

### 9.3 匹配与「要不要用模型」

| 层 | 做法 | 成本 |
| --- | --- | --- |
| L1 词典匹配 | 标题小写化后用 `entities.ts` 的中英别名做子串匹配；英文按词边界（`\b`），中文按双字以上子串 | 0 |
| L2 同义扩展 | 「台积电」→ `tsmc` / `台積電`（词典里已有 en 别名，直接复用） | 0 |
| L3 模型复核 | 仅当 L1 命中且标题含歧义词（如「苹果」）时，调一次小模型判「这条讲的是公司还是水果」 | 1 点/次，**每人每天最多 10 次** |

L1 覆盖 90% 场景。L3 必须存在的原因：Geo/消费类实体（苹果、小米、长城）纯字符串匹配误报率极高，
不判就会天天推错东西 —— 而「推错一次」对这种产品是致命的。

### 9.4 通知只做站内

不发邮件、不发短信、不接 Webhook：

- 侧栏「关注」项上挂未读数（`GET /api/watch` 的 `unread` 汇总，一次请求拿全）。
- `/account/watch` 列表 + 命中明细，点开即 `POST /api/watch/read`。
- 站点顶部复用 `UpdateBanner` 的位置做一条「你关注的 X 有 N 条新消息」（仅当未读 > 0）。

不发邮件是刻意的：邮件通道一开，就要处理退订、SPF/DKIM、被举报风险，且在备案口径里又多了个「营销」嫌疑。

---

## 10. P2 结果分享（细节）

### 10.1 token 与生命周期

```ts
const token = base64url(randomBytes(32));   // 43 字符，160 bit 熵，猜不出来
```

| 项 | 口径 |
| --- | --- |
| 默认有效期 | 30 天（`ttlDays` 可 1–90；`null` 只在后台手动放开） |
| 撤销 | `revoked_at` 置位 → 立即 410，且 `Cache-Control: no-store` 防中间缓存留尸 |
| 每人上限 | 100 条有效分享（超了要删旧的才能建新的，返回明确错误码） |
| 访问限流 | `PROBE_SHARE_RATE_PER_MIN` 默认 120（按 IP），防被人拿来扫 token |
| 索引 | `noindex, nofollow` + 不进 sitemap + `robots.txt` 的 `Disallow: /s/` |

### 10.2 脱敏（默认开）

`redact=1`（默认）时：

- `query` 原文**不渲染**，只在页脚标「分享者隐去了原始提问」。
- 实体名、来源域名保留（这是价值所在），但把「只有分享者才知道的上下文」去掉（例如 query 里的人名）。
- 页面 `<title>` 用 `shares.title ?? 面板标题`，绝不用 query 原文（否则 query 会进浏览器历史、搜索框、链接预览）。

### 10.3 OG 图（`next/og`）

分享链接在 IM 里展开的样子，本质上就是这个产品的对外名片。所以：

- 1200×630，纯黑底 + 三色统计（支持/矛盾/无法判定）+ 一句「每个数字都能点回原文」。
- **不画模型摘要**。摘要一进图，就没法标「AI 生成」，且会被当成我们的观点转载。
- `Cache-Control: public, max-age=300`（token 撤销后最多 5 分钟内还可能被缓存，可接受）。

### 10.4 分享页的运行时

`/s/[token]` 是 **server component**，从库里读出 `queries` + `query_sources` 直接渲染，**不触发任何上游调用**。
这意味着：分享页的打开速度与额度、检索源、模型全无关 —— 它是静态数据的只读视图。这一点要在实现时守住，
否则「有人分享 → 一百个人打开 → 烧光额度」是必然会发生的。

---

## 11. 合规与备案红线（这一节请先看再决定要不要做 P2）

### 11.1 P2 会改变站点的「性质」

首次备案（个人主体）的原则是：**网站内容由站长自己提供**。而公开的分享页是**用户提供内容并公开可见**，
在备案审核口径里属于「交互式服务 / 用户生成内容」。可能触发的后果：

| 触发点 | 后果 |
| --- | --- |
| 审核员看到任意人可打开的 `/s/<token>` 页面 | 要求补充说明或直接驳回（个人主体做交互式服务常被要求转企业主体） |
| 分享内容里出现敏感词（用户自己提问触发） | 站点被判定为「内容未审核」，需要建立审核机制 —— 这就是内容平台义务 |
| 备案信息里的「网站服务内容」与实际不符 | 备案信息不实，后续变更/年审出问题 |

**结论：P2 在「首次备案通过」之前不要上线。** 通过之后再上，也要在备案信息里如实写（服务内容含用户分享），
并准备一份「内容处置规则」（谁能分享、什么情况撤销、举报入口）。

### 11.2 三件事都要做的合规动作

| 动作 | 落点 |
| --- | --- |
| 隐私政策更新 | `src/app/privacy/page.tsx` 第五节「保存多久」+ 新增「账号级历史」小节：存什么（query/结构/引用）、不存什么（正文）、留 90 天、可导出可删除、删除是立即物理删除 |
| 生成式 AI 标识 | 分享页与历史的只读视图仍要显示 `AiNotice`（模型生成的摘要/判定），这是《生成式人工智能服务管理暂行办法》第 12 条 |
| 日志留存 | 分享访问不记 IP（我们主动放弃），但 nginx access log 本来就有，已按 180 天轮转（`/etc/logrotate.d/nginx`），满足 ≥6 个月 |
| 个人信息「最小必要」 | 历史里**不存** IP、UA、设备指纹；只有 `user_id`（内部标识，不是手机号/邮箱） |
| 未成年人 | 注册已有 14 岁门槛（隐私政策第 6 节），历史功能不额外暴露 |

### 11.3 一条容易被忽略的：数据出境

历史本身不出境（SQLite 在我们自己的机器上）。但**重跑一条历史**会重新走检索与模型，
于是仍然受区域策略约束：境内访客重跑走境内模型/博查，境外访客走 OpenAI/Tavily。
所以 `queries.region` 必须落库 —— 它不只是统计字段，是「这条记录当时是否发生过数据出境」的证据。
---

## 12. 隐私影响评估（新增存了什么，逐项过一遍）

| 新增数据 | 敏感性 | 为什么必须有它 | 能不能不存 |
| --- | --- | --- | --- |
| `queries.query`（提问原文） | 中 —— 提问会暴露关注点 | 没有原文的「历史」就是一组无意义的数字 | 能：`PROBE_HISTORY_STORE_QUERY=0` 只存 hash，列表显示「(已隐去)」。**建议保留开关** |
| 面板统计（claims/supported/…） | 低 | 「值不值得再看一眼」全靠它 | 能省，但省了就没人点开 |
| `source_hosts`（域名） | 低 | 判断信源质量 | 能省，用 `source_n` 代替 |
| `query_sources.url` | 中低 —— URL 可能含搜索参数 | 点回原文是产品命门 | 不能省（但**不存**正文与 `quote` 原文，只存 hash） |
| `degraded`（降级码） | 低（内部码） | 事后判断「这次为什么薄」 | 不能省，否则用户和我都说不清 |
| `region` | 中 —— 说明来源地区 | 出境证据 + 结果可复现 | 不能省 |
| 关注实体名 | 中 —— 暴露关注对象 | 功能本体 | 不能省（但要能一键取关即删） |
| 分享 token | 低 | — | 不能省 |

**明确不存的**：IP、UA、设备指纹、正文、模型完整输出、其它人的 history、浏览行为流水（`events` 只有我们主动定义的名字，且不含 URL）。

---

## 13. 容量与成本

估算口径：一条历史 = `queries` 一行（约 400 字节）+ `query_sources` 5–15 行（约 150 字节/行）≈ **1.2–2.6KB**。

| 规模 | 历史总量 | 数据库体积 | 说明 |
| --- | --- | --- | --- |
| 20 人 × 每天 5 次 × 90 天 | 9,000 条 | ~20MB | 现在的真实量级 |
| 200 人 × 每天 5 次 × 90 天 | 90,000 条 | ~200MB | 单机 SQLite 毫无压力 |
| 2,000 人 × 每天 5 次 × 90 天 | 900,000 条 | ~2GB | 该考虑把 90 天降到 30 天，或按年分库 |

查询成本：`(user_id, created_at)` 复合索引下分页是 O(log n)，10 万行级别的列表查询 < 2ms。
**唯一要小心的**是 `q=` 的子串搜索（`LIKE '%x%'` 无法用索引）—— 所以它被限制在「只搜自己的、且先按 user 过滤」的小集合上；
真到十万行再说 FTS5（SQLite 内置，`CREATE VIRTUAL TABLE ... USING fts5`，仍零依赖）。

### 13.1 单进程到底够不够（2026-10-26 实测）

上面全是按数据量估的算力，缺一条「这台机器实际能扛多少」的数。补完了，结论是**够，而且余量很大**。
全部在线上那台（2 核 4G / 5Mbps，node 22.23.4 + Next 16 生产模式）本机直连 `127.0.0.1:3215` 测，
细节与脚本在 `docs/OPS.md` §九。

| 维度 | 实测 | 判断 |
| --- | --- | --- |
| SSR 页面（`/login`，60 秒 20 并发） | **153 rps**，p50 125ms / p95 180ms / p99 203ms | 约 9000 次/分钟，邀请制到不了 |
| 轻端点（`/api/version`，60 并发） | 818 rps，p95 126ms | 没到墙，压测端先到 |
| 稳态 CPU | 100–130%（2 核里 1.1 核），峰值 133% | 单线程事件循环吃满一核，第二核只分担 GC/libuv |
| RSS | 207MB → 258MB，40 秒后走平 | 不是泄漏，是路由缓存被填满 |
| cron 中途插入（真实 `/api/cron/heat`，4.2s） | RPS 149 vs 基线 153，逐秒无尖刺 | **不需要为定时任务拆进程** |
| 首屏 gzip 体积 | 168KB（`/`，3 个同步 chunk） | 5Mbps ÷ 168KB ≈ **3.7 个首屏/秒** |

所以真正的瓶颈排序是 **带宽 ≫ SSR ≫ CPU**，而且带宽撞得很早：十几个真人同时开首页就能吃满 5Mbps，
表现是「转圈」而不是错误。往上走的顺序也因此确定：先 CDN/COS 托管 `/_next/static/`，再升带宽，
最后才谈多进程或多机 —— 到那一步 CPU 反而还是富余的。

这也顺手确认了一件事：**加中文源（IT之家/少数派）和国内榜单（百度/掘金）没有拖慢 SSR**
（`/api/version` 653→654、`/login` 133→132，都在噪声里）。它们走的是缓存 + 拼装，不进渲染热路径。

---

## 14. 备份、恢复、部署

### 14.1 备份脚本要改的地方（`scripts/server/backup-probe.sh`）

```
现状：tar 打包 .data/auth/store.json + consent.log + .cache/*
改为：打包前先 PRAGMA wal_checkpoint(TRUNCATE)（否则 -wal 里的新数据没进主文件），
      打包 .data/probe.db（单个文件即可），跳过 -wal/-shm（已 checkpoint）
校验：store.json 合法 JSON（已有）+ 用 node --experimental-... 不需要 —— 直接 `node -e` 打开 db 跑
      `PRAGMA integrity_check` 与 `SELECT count(*) FROM queries`，非 ok 即备份失败
```

关键点：**备份失败的告警不能等到恢复时才发现**。现有脚本「store.json 缺失即失败」的思路照搬，
新增「probe.db 打不开即失败」。

### 14.2 恢复演练（每季度一次，写进 docs/OPS.md）

```bash
systemctl stop probe-web
mv .data/probe.db .data/probe.db.bad            # 留下现场
tar xzf /root/backups/probe/probe-YYYYmmdd.tar.gz -C /tmp
cp /tmp/.../probe.db .data/probe.db && chmod 600 .data/probe.db
rm -f .data/probe.db-wal .data/probe.db-shm      # 必须删，否则会回放旧 WAL
systemctl start probe-web
curl -s localhost:3215/api/version && curl -s -b ... localhost:3215/api/history?limit=1
```

### 14.3 与自动部署的关系

`update.sh` 替换源码、**保留 `.data/`**，所以：

- 新代码第一次起来时会打开**旧结构的库** → `migrate()` 必须能在 `user_version=0` 上跑通（首次建表）。
- 回滚到旧版本（`.next-old`）时，旧代码不认识新表 —— 不读就不会坏；但**旧代码不会写历史**，
  所以回滚意味着「回滚期间产生的提问不进库」，这是可接受的降级。

---

## 15. 观测（不新造一套）

| 要看的 | 从哪看 |
| --- | --- |
| 写库失败 | `jsonError` 只在 5xx 记；历史写失败是 `console.warn`，用 `journalctl -u probe-web` 再筛 `history` 关键字 |
| 历史量 | 后台「设置」加一行 `queries` 行数 + 库体积（读 `PRAGMA page_count * page_size`） |
| 分享访问 | `shares.views` + `events` 里 `share.view` 计数（后台看） |
| 关注命中 | 后台「用户」页每人的 watch/hits 计数 |
| 慢查询 | 有 `db.prepare(...)` 的地方都加 `-- 注释说明用途`；P2 之前不做 profile（量太小） |

---

## 16. 测试计划

| 类型 | 文件 | 覆盖什么 |
| --- | --- | --- |
| 迁移 | `tests/db-migrate.test.ts` | 空库 → v1；重复 migrate 幂等；坏库（user_version 超前）→ 明确报错而不是静默降级 |
| 写点 | `tests/history-store.test.ts` | 单事务写入（sources 与主行同生共死）；超过 500 条自动删最旧；`expires_at` 计算；`query` 截 400 |
| 隔离 | `tests/history-api.test.ts` | A 读不到 B 的（404 而不是 403）；DELETE 幂等；上限触发 429 |
| 导入 | 同上 | 200 条上限、去重、非法 at（NaN/未来时间）被夹紧 |
| 关注 | `tests/watch.test.ts` | 词典匹配中文/英文别名；歧义词走 L3 才记点；`UNIQUE(watch_id,url)` 去重；取关级联 |
| 分享 | `tests/share.test.ts` | token 熵（长度/字符集）；过期 410；撤销 410；`redact=1` 时 query 不出现在 HTML 里（源码级断言） |
| fuzz | `scripts/probe-fuzz.mjs` | 把 `/api/history`、`/api/watch`、`/api/share` 加进畸形输入清单（新端点必须结构化错误） |
| 护栏 | `tests/hardening.test.ts` | 源码级：分享页 `export const revalidate = 0` 且无 `fetch(`；`/api/history` 的 SQL 里出现 `user_id = ?`；`migrate` 只在 `src/lib/db/` 里被调用 |

CI 现状（`.github/workflows/ci.yml`）已在 push 跑 typecheck + build + smoke + fuzz，新测试自动纳入 `npm test`。

---

## 17. 分阶段实施（文件清单 + 验收标准）

### P0：账号级历史（预计 1.5–2 天）

```
新增  src/lib/db/index.ts            适配层（唯一 import node:sqlite）
新增  src/lib/db/migrate.ts          v1 DDL + user_version
新增  src/lib/history-store.ts       saveQuery / listQueries / getQuery / deleteQuery / pruneForUser
新增  src/app/api/history/route.ts            GET 列表 / DELETE 清空
新增  src/app/api/history/route.ts            GET / DELETE（?id= 走详情/单条删除，不建 [id] 目录）
新增  src/app/api/history/import/route.ts     POST 导入
新增  src/app/api/history/export/route.ts     GET 导出
改    src/app/api/search/route.ts     done 之后 saveQuery（try/catch 包住）
改    src/app/api/verify/route.ts     同上（intent_kind='verify'，存 title + doc_hash）
改    src/lib/history.ts              保留 localStorage 但降级为缓存 + 迁移标记
改    src/components/*               侧栏读服务端；/account 加历史块
改    scripts/server/backup-probe.sh  checkpoint + probe.db + integrity_check
改    src/app/privacy/page.tsx        加「账号级历史」小节
改    .env.example                   PROBE_HISTORY_* 四个开关
新增  tests/db-migrate.test.ts / history-store.test.ts / history-api.test.ts
```

验收：

1. 两台设备登录同一账号，A 提问后 B 刷新能看到（≤1 个 SSE 结束的延迟）。
2. 删一条，`query_sources` 一起消失（`SELECT count(*)` 前后差 = N）。
3. 90 天前的记录查不到（把 `expires_at` 改成过去，跑清理，行数下降）。
4. 关掉 `PROBE_HISTORY_SERVER=0` 后：搜索仍正常，侧栏显示本地副本 + 「离线」标记。
5. 备份文件能恢复出同样的 `count(*)`（演练一次）。
6. `npm test` + `npx tsc --noEmit` + fuzz 全绿。

### P1：关注实体回流（已实施 · 2026-10）

```
新增  src/lib/db/migrate.ts 的 v2（watches / watch_hits）
新增  src/lib/watch-store.ts            addWatch / removeWatch / listWatches / recordHits / markRead
新增  src/lib/watch-match.ts            词典匹配（复用 entities.ts）+ 歧义词表
新增  src/app/api/watch/route.ts        GET / POST
新增  src/app/api/watch/route.ts        DELETE（?id=；P1）
新增  src/app/api/watch/hits/route.ts   GET / POST read
改    src/app/api/cron/heat/route.ts    末尾跑一轮 applyHits()
改    src/components/*                 实体旁「关注」按钮（ResultRail 芯片）+ /account 的 WatchPanel
删    src/lib/llm.ts                   L3 复核记点（未做，见下方实施结果）
```

验收：关注「台积电」，构造一条含 `TSMC` 的假热榜条目 → 命中入库、未读 +1、点开后 `read_at` 置位、重复条目不重复计。

**实施结果（2026-10-26 走完全流程）**

- 落地文件与上面清单基本一致，两点偏差：
  - **没有做 L3 模型复核**（`llm.ts` 未改、没有新增计费单元）。理由：歧义词表 + 上下文正则已经能把「苹果价格」这类挡在库外，为了一条提示去烧一次模型调用不划算；真要补，是 `watch-match.ts` 里加一个可选的 L3 回调，接口不用动。
  - 「关注」按钮不只出现在 /account，`ResultRail.tsx` 的实体芯片直接可点关注（演示时最有说服力的入口是搜索结果页，不是设置页）。
- 新增配置：`PROBE_WATCH_SERVER`（默认 1）、`PROBE_WATCH_PER_USER`（50）、`PROBE_WATCH_HITS_PER_WATCH`（50）、`PROBE_WATCH_HIT_DAYS`（30）、`PROBE_WATCH_RATE_PER_MIN`（60）、`PROBE_WATCH_WRITE_PER_MIN`（10）。
- 开关跟历史走：历史关掉（`historyEnabled() === false`）时关注整件也关，读接口回 `enabled:false`、写接口回 404 `watch_disabled`，前端组件 `return null`。
- 测试：`tests/watch-store.test.ts` 15 条 + `tests/hardening.test.ts` 3 条护栏，合计 391/391。
- 端到端实测（本地 3311，auth off）：加关注「台积电」→ 种一条含 TSMC 的假条目 → `hits:1 / unread:1` → 再种一次 `inserted:0` → 点开 `changed:1 / unread:0`。设计验收全过。
- 已知取舍：`recordHits` 只吃 `topics[].stories`（热榜里进了统计的那批），没过统计的噪音不触发命中；每关注最多留 50 条、总保留 30 天，超了删最旧（`pruneHits` 在 cron 里顺带跑）。

### C 期 · B 阶段：国内热议榜单（已实施 · 2026-10-26）

用户拍板的 C = 「两条轨并存」：热榜轨（HN + 30 天基线，不动）与榜单轨（国内公开榜单，**不进热度公式**）。
这一版只做 B 阶段（榜单轨）；A 阶段（把 IT之家/少数派接进热度公式）压后，因为中文源要单独建 14 天基线，
在那之前所有状态标签都不可信。

```
新增  src/lib/hotlist.ts                  parseBaiduBoard / parseJuejinRank / getHotLists / hotStories
新增  src/components/HotListBoard.tsx     两块榜单 + 口径说明（客户端组件，无请求）
新增  tests/hotlist.test.ts               10 条
改    src/app/page.tsx                    与 getTrending 并行取（Promise.all），拿不到就是 null
改    src/components/Workspace.tsx        props 加 hot，TrendingBoard 之后渲染，中间画一条分隔线
改    src/app/api/cron/heat/route.ts      getHotLists()（不带 force）→ hotStories → recordHits，响应加 hot 字段
```

**为什么是并行取**：两块互不依赖，串行等于让首屏多等一次网络往返。榜单那侧自带 6s 超时 + 15 分钟缓存，
最坏情况是首屏慢 6 秒、少一块；不做成客户端懒加载是因为它就在首屏、懒加载等于让页面先空一块再跳。

**为什么榜单不进 `heat.ts`**：站立的承诺是「每个数字都能点回原文」。HN 那套数字背后是 30 天基线 + MAD 离群判断，
是国内源没有的东西。把百度的 hotScore 混进同一个公式，等于让一个没有基线检验的数字冒充我们的判断。
所以榜单上每个数字都标了它是谁给的（「百度热度」/「阅读 1204」），页面上也直接写「榜单原样 · 不参与热度公式」。

**上游选择（实测过一轮，不是拍脑袋）**

| 源 | 接口 | 结果 | 用途 |
| --- | --- | --- | --- |
| 百度热搜 | `top.baidu.com/api/board?platform=pc&tab=realtime` | 200，50 条，带 hotScore/hotChange/desc | 展示 + 关注命中 |
| 掘金 | `api.juejin.cn/content_api/v1/content/article_rank?category_id=1&type=hot` | 200，50 条，有 hot_rank，**ctime 恒为 0** | 展示 + 关注命中（不画变化角标） |
| 微博 | `weibo.com/ajax/side/hotSearch` | 403 Forbidden | 不接 |
| 知乎 | `zhihu.com/api/v3/feed/topstory/hot-lists/total` | 401 AuthenticationError | 不接 |
| V2EX | `api/v2/topics/hot` | 超时 | 不接 |
| IT之家 / 少数派 | `api.ithome.com/json/newslist/news` / `sspai.com/api/v1/article/...` | 200，有发布时间 | 留给 A 阶段（进公式） |

**解析上的两条硬规则**（都有测试兜着）

1. 链接只放行 `http(s)`：`javascript:` / `data:` 到了 `<a href>` 上就是 XSS 入口，上游一旦被污染我们不跟着走。
2. 掘金的 `content_id` 必须是 `/^\d{6,}$/` 才拼 URL：否则一个带 `../` 的 id 能把条目指向任意站（开放跳转）。

**限速就是缓存**：`CACHE_TTL_MS = 15 分钟` 是唯一的闸门。cron 每 5 分钟一轮、`getHotLists()` 不带 force，
所以对上流实际是「最多每 15 分钟一问」；失败时缓存只留 60 秒，避免一次抖动把整块榜单钉死 15 分钟。

**验收（已实测）**：本地起 `npx next start`，首屏出现「国内热议」两块；断网/关开关时整块消失而页面照常；
`npm test` 405/405（含 4 条护栏：只许打两个已知 host、`javascript:` 被丢、cron 不带 force 且失败只 warn、`heat.ts` 里不出现榜单）。

### C 期 · A 阶段：中文科技前沿（已实施 · 2026-10-26）

B 阶段上线当天就接着做 A 阶段，理由是**基线越早挂越好**：这两个源没有历史检索接口，
只能从挂上那天开始攒，攒够 14 天才出状态标签。晚一天挂就晚一天有标签。

```
新增  src/lib/cn-history.ts               mergeCnDay / cnSeries / cnHistoryMeta / readCnHistory / recordCnStories
新增  src/lib/cn-trending.ts              fetchCnStories / getCnTrending / recentCnStories / cnTrendingEnabled
新增  src/lib/heat-labels.ts              HEAT_STATUS_TEXT / HEAT_STATUS_CHIP / HEAT_STATUS_ORDER（两条轨共用）
新增  src/components/CnTrendingBoard.tsx  名次 + 状态徽章 + 内联 spark + 每话题 3 条原文
新增  tests/cn-trending.test.ts           11 条
改    src/lib/topic-terms.ts              新增 matchTopicNamesZh（中文别名走 includes，英文走 \b 边界）
改    src/components/TrendingBoard.tsx    状态文案改为 import 自 heat-labels（同公式就得同文案）
改    src/app/page.tsx                    Promise.all 里加第三路（开关关掉就传 null）
改    src/components/Workspace.tsx        props 加 cn，TrendingBoard 与 HotListBoard 之间
改    src/app/api/cron/heat/route.ts      getCnTrending(true) → recentCnStories() → recordCnStories → recordHits
```

**必须先修的坑：`matchTopicNames()` 认不了中文。** 它只按 `a.en` 建 `\b<en>\b` 正则，
中文别名完全不参与 —— 直接把中文源接进去，榜单会**恒为空**，而页面上看起来像「今天没什么事发生」。
这种空不会报错、不会记 degraded，是最容易长期没人发现的一类。所以新开 `matchTopicNamesZh()`：
CJK 别名用 `title.includes(alias)`，ASCII 别名仍走 `\b` 边界 + `i`；展示名沿用同一条规则
（`CJK_RE.test(a.zh[0]) ? a.zh[0] : a.en`），保证同一个实体在两块榜上叫一个名字。
四条护栏盯着这件事（含「不许退回只认英文别名的匹配」）。

**为什么单独一份基线**：`seriesStats(series)` 少于 14 天直接返回 null —— 这个门槛不是拍的，
两周不到算不出「平时是什么样」。中文源一天不到 150 条、HN 一天上千条，同一条中线放两条分布上，
「多少条在写它」的含义完全不同。所以 `.cache/cn-history.json` 与 `hn-history.json` 各自独立，
两套 r7 不互相污染。

**日计数怎么才不假**：去重靠「当日唯一 URL 集合」（`known.has(url)`）。cron 每 30 分钟一轮，
没有它同一篇文章会被数 20 遍，日计数变成「轮次 × 条数」。没命中实体的 URL 也要记进集合
（否则它每轮都被重新匹配一遍，白算）。seen 只留两天（今天 + 跨零点那一轮的昨天），日计数留 45 天。

**两个上游解析坑（都有测试锁定）**

1. IT之家 `postdate` 是「北京时间但字符串里没有时区」（`"2026-10-26T09:13:15.287"`）。
   直接 `Date.parse` 在 UTC 机器上会把 9 小时前的稿算成 9 小时后 —— 24 小时窗口就漏掉一半。
   必须 `Date.parse(s + "+08:00")`。
2. 少数派翻页 `offset += 实际返回条数`，不是 `+= limit`：`limit=20` 实际只回 10 条，
   固定 +20 会整页跳过（50 条只能拿到 30 条）。

**覆盖不满 24h 就说 24h 不够**：IT之家接口 25 条≈10h、RSS 60 条≈13h，合并去重后仍不满 24h。
`CnSourceMeta.coveredHours` 照实算，页面写「覆盖约 N 小时」，不假装是全天。

**已知取舍**：没做「关注实体的加权」（命中关注的话题不会因此排名上升，只是同样进 `recordHits`）；
没做少数派 `content_api`（那个接口 `ctime` 恒为 0，无发布时间）；
「加密 / 隐私 / 安全」刻意没收进中文实体表（中文新闻里的口头禅，收进来每个话题都被命中一次）。

**验收（已实测）**：`npm test` 421/421（+11 条 cn 测试 + 4 条护栏）；
`npx tsc --noEmit` 0；cron 响应体新增 `cn` 字段（`topics` / `sources` / `baseline` / `inserted` / `degraded`）。

### P2：结果分享（预计 2–3 天 + 合规确认）

```
新增  v3（shares / events）
新增  src/lib/share-store.ts            createShare / revokeShare / listShares / readShare
新增  src/app/api/share/route.ts        POST / GET
新增  src/app/api/share/[token]/route.ts DELETE
新增  src/app/s/[token]/page.tsx        公开只读（noindex、无上游调用）
新增  src/app/s/[token]/og/route.tsx    next/og 卡片图
改    src/app/robots.ts                 Disallow: /s/
改    src/app/privacy / src/app/terms  分享条款（谁负责、撤销权、举报入口）
```

验收：匿名浏览器（无 cookie）能打开分享页；`view-source` 里搜不到 query 原文（redact=1）；过期/撤销 → 410 且无缓存头漏洞；OG 图能出。

---

## 18. 风险与回滚

| 风险 | 概率 | 影响 | 缓解 | 回滚 |
| --- | --- | --- | --- | --- |
| `node:sqlite` 实验性 API 在下个 Node 小版本变化 | 低 | 起不来 | 所有调用都在 `src/lib/db/index.ts`；`npm test` 的迁移用例会先炸 | 换 `better-sqlite3`（同一个适配层，机器有 g++/make/python3） |
| 库文件被自动部署覆盖 | 极低 | 历史全丢 | `.data/` 在删除列表之外（已核实 update.sh） | 从每日备份恢复 |
| 写库阻塞请求 | 低 | 首屏变慢 | 同步写只做单行 INSERT（微秒级）；批量清理限 500 行/次 | 关 `PROBE_HISTORY_SERVER=0` |
| WAL 文件被单独备份/恢复导致不一致 | 中 | 数据回退 | 备份前 checkpoint；恢复时删 -wal/-shm（写进 OPS） | 重新从上一个备份恢复 |
| 分享页被人当免费图床/内容托管 | 中 | 备案风险 | 默认 `noindex`、默认 30 天、每人 100 条、`redact` 默认开 | `PROBE_SHARE_ENABLED=0` 一键关（页面 410） |
| 注册人数暴涨后历史撑爆磁盘 | 低 | 服务不可用 | 每人 500 条 + 90 天 + 探活里加磁盘 ≥90% 告警（已有） | 降保留期到 30 天，跑一次清理 |

**总开关**：`PROBE_HISTORY_SERVER` / `PROBE_WATCH_ENABLED` / `PROBE_SHARE_ENABLED` 三个环境变量，
任一关掉都让对应功能像没上线（接口 404/410，界面隐藏，不报错）。这是这个项目一贯的做法 —— 功能要能「不见」。

---

## 19. 我明确不建议的做法

| 做法 | 为什么不做 |
| --- | --- |
| 把正文 / 模型输出整段落库当缓存 | 一旦落库，我们就是内容托管方：要审、要删、要担责，且备份体积暴涨。宁可慢一点回源 |
| 用 `store.json` 存历史 | 每次写全量文件，1000 条以后就是「每提问写 200KB」，而且 auth 的原子性会被拖累 |
| 历史做「跨用户搜索」 | 立刻变成社区/搜索引擎，备案性质变了不说，还会泄露别人的关注点 |
| 分享做成公开广场（列表/热门/点赞） | 同上，且与「Geek 工具」定位冲突 |
| 上 Redis 做限流共享 | 单进程跑得好好的，引入 Redis 只为了一个不存在的问题（b6 已实测：SSR 153 rps、CPU 峰值 0.67 台，先撞的是 5Mbps 带宽，见 `docs/OPS.md` §九与本文 13.1） |
| 关注做成邮件/微信推送 | 邮件要退订与 SPF/DKIM，微信要主体资质。站内未读足够 |
| 历史默认存 query 原文不给开关 | 「提问原文」是这堆数据里最敏感的，必须有 `PROBE_HISTORY_STORE_QUERY=0` 的退路 |

---

## 20. 工作量（按我实际的开发速度估）

| 阶段 | 代码 | 测试 | 文档 | 小计 |
| --- | --- | --- | --- | --- |
| P0 | 1–1.5 天 | 0.5 天 | 0.2 天 | **1.5–2 天** |
| P1 | 0.8–1.2 天 | 0.3 天 | 0.2 天 | **1–1.5 天** |
| P2 | 2 天 | 0.5 天 | 0.5 天（含条款） | **2.5–3 天** |

（不含备案/合规等待时间；P2 的合规确认可能比写代码更久。）

---

## 21. 需要你拍的四件事

1. **P2 要不要做**：如果首次备案还没通过，我的建议是先只做 P0+P1，通过后再上分享。
2. **提问原文存不存**：默认存（有 `PROBE_HISTORY_STORE_QUERY=0` 开关）。若你觉得「连原文都不该留在服务器」，
   那就变成只存 hash —— 代价是历史列表里点开只有统计，没有那句提问。
3. **保留期**：90 天（默认）还是 30 天？后者更干净，但要接受「上个月问的看不到了」。
4. **要不要把 auth 也搬进 SQLite**：我建议**不搬**（第 3.3 节）。如果你希望「只有一个存储」，那也是一次独立的重构，别和 b2 混在一起。
---

## 22. 实体追踪与公开核验（已实施 · 2026-10-26）

用户原话（m04848）：「增加公司或实体追踪」；m04862 追加：「热点事件追踪时间线
根据不同的消息来源和可信度在时间线上创造分支」；m04891：「两个都做」。
这一节记**实际做了什么、为什么这么做、哪些地方我故意没做**。

### 22.1 两件事，一套底座

| 交付 | 页面 | 数据 | 用不用登录 |
| --- | --- | --- | --- |
| 实体追踪 | `/entities`（7 天榜）、`/e/<key>`（单实体时间线） | `entity_hits` 表 | 不用，公开只读 |
| 公开核验 | `/check` | 无（不落库） | 不用，只收正文 |

它们共用的东西其实只有一个：**「先给证据，再给结论」的写法**。数据上完全不相干 ——
一个往库里写索引，一个连历史都不写（`if (ctx.userId) persistQuietly(...)`），
关掉任一不影响另一。

### 22.2 文件清单

新增：

- `src/lib/entity-track.ts`（约 326 行）：词典实体、命中落库、分页读、概览、7 天榜、统计。
- `src/lib/entity-timeline.ts`（168 行）：`titleTokens` / `similarity` / `buildTimeline`。
- `src/lib/source-tier.ts`（140 行）：来源分档（1 官方 / 2 主流 / 3 行业 / 4 聚合）。
- `src/app/api/entity/route.ts`：公开只读接口（无 key 给 7 天榜，带 key 给时间线）。
- `src/components/EntityTimeline.tsx`：主干 + 分支的渲染（server component）。
- `src/app/e/[key]/page.tsx`、`src/app/entities/page.tsx`：公开页。
- `src/components/CheckPanel.tsx`、`src/app/check/page.tsx`：公开核验。
- `tests/entity-track.test.ts`（17 条）、`tests/entity-timeline.test.ts`（14 条）、
  `tests/source-tier.test.ts`（10 条）。

改动：

- `src/lib/db/migrate.ts` 追加 v3：`entity_hits` + 两个索引。
- `src/app/api/cron/heat/route.ts`：三条来源的 story 汇到 `entityStories`，末尾统一落库。
- `src/app/api/verify/route.ts`：新增匿名分支（`x-probe-anon: 1`）。
- `src/app/sitemap.ts` 加 `/check` 与 `/entities`；`src/components/SiteFooter.tsx` 加两条导航。
- `tests/hardening.test.ts`：+7 条护栏。

### 22.3 时间线怎么分叉（这是这块的核心算法，没有模型）

```
titleTokens(title)  → ascii 词（长度≥3 或纯数字）+ 中文 2-gram，去停用词
similarity(a, b)    → 两个 token 集合的 Jaccard 相似度
buildTimeline(hits) → 逐条与每个簇的「第一条」比：
                      相似度 ≥ threshold(0.5) 且 时间差 ≤ windowHours(48) → 进同一簇
                      否则开新簇
                    每簇：主干 = 档位最高者（同档取更早），其余按档位排前 maxBranches 当分支
```

三个刻意的选择：

1. **和簇的第一条比，不和簇的质心比** —— 质心会让「同一件事的第 5 篇」漂得越来越远，
   最后把两件事缝在一起。和第一条比，簇的边界永远由最早那条定义，可复现。
2. **没有模型参与**。相似度和档位都是纯函数，同样的输入永远同样的输出。
   加模型意味着「同一批数据刷新两次，分叉结果不同」—— 时间线一旦会变，它就不可引用。
3. **档位只由 `host` / `provider` 决定，域名优先**。ithome 的链接无论从哪条管线来都是 3 档；
   未收录的域名一律 4 档（「未分级来源，按最低档处理」）。

页面上「说法不一致」的判据是分支相似度 < 0.55（刚过 0.5 门槛那一档），
「档位差 N」是主干与分支的档位差 ≥ 2。**两者都是提示，不是判决** ——
同一件事 Reuters 与某聚合站的标题本来就该不一样。

### 22.4 匿名核验的边界（为什么这么抠）

- **必须显式带头**：`x-probe-anon: 1`。不能让「cookie 过期」静默掉进匿名路径 ——
  那会让每个掉登录的用户都在花全站额度，而且彼此看不见。
- **只收正文**：给 `url` 直接 422 `anon_text_only`。代抓链接 = 给陌生人开免费代理
  （出口 IP 共享 + 任意内网地址），这条没有折中。
- **不落历史**：`persistQuietly` 两处（json / sse）都套了 `if (ctx.userId)`。
  只改一处的话，匿名核验照样会往 `queries` 表写 `user_id=""` 的行 —— 测试里断言了「恰好 2 处」。
- **两道闸**：每 IP 1 次/分（`createLimiter`）+ 全站 40 次/天（`anonDaily`，按 UTC 日界）。
  前者防一个人刷，后者防一群人刷。额度按 `anon:<sha256(ip)[:12]>` 记账，
  和登录用户的 `u:<id>` 分在两个桶里，互不侵占。

### 22.5 验收（实测）

- `npx tsc --noEmit` 0；`npm test` **462/462 PASS**（起点 421，+41 新）。
- 新建的 41 条里，最有价值的三条是：`PRAGMA table_info(entity_hits)` 不含 user_id；
  `if (ctx.userId) persistQuietly` 恰好 2 处；`source-tier.ts` 不含任何 llm 调用。
  这三条都是「以后有人顺手加功能时会踩」的坑，不是形式主义。

### 22.6 我故意没做

- **不做实体详情页的「综合结论」**：那需要模型读多篇正文并归纳，等于替读者下判断，
  与「每个数字点得回原文」直接冲突。页面只列事实与来源。
- **不做搜索框、不做关注实体的公开主页**：公开 + 可搜索 + 可订阅 = 社区，
  备案口径会从「工具」变成「UGC 平台」。
- **不把 `entity_hits` 和 `watches` 合并**：关注是**某人的**（有 user_id），
  时间线是**所有人的**（没有）。合并那一刻，公开数据就开始携带私有语义。
- **匿名核验不给 SSE**：只有 `format:"json"`。流式意味着长连接，
  匿名 + 长连接 + 40 次/天，是三个互相矛盾的东西。

### 22.7 v4 迁移：把「发布时刻」和「抓取时刻」拆开（当天补的）

第一版把 `at` 直接取 `created_at`（落库时刻），本地一冒烟就露馅：同一轮抓到的
Reuters / IT之家 / 百度三条落库时间戳逐字节相同，页面上「跨度」恒为 0h，
跨来源顺序其实是插入顺序；一篇三天前的旧闻今天被抓到，也会被算进「24 小时」。

所以加了 v4：

```sql
ALTER TABLE entity_hits ADD COLUMN pub_at INTEGER;
UPDATE entity_hits SET pub_at = created_at WHERE pub_at IS NULL OR pub_at <= 0;
CREATE INDEX idx_entity_hits_key_pub ON entity_hits(entity_key, pub_at DESC);
```

- 读路径：`at = pub_at || created_at`，排序与分页按 `pub_at`，24h/7d 与 7 天榜都按 `pub_at`。
- 写路径：`pubMsOf(story, now)` 解析 `seenAt`；解析不出来、未来时间、非正数 → 退回 `now`。
  宁可退回抓取时间，也不让一条脏数据把时间线拉到 1969 年。
- `created_at` 仍然保留，用途只剩两个：每实体条数上限的裁剪顺序、保留期清理。
- 迁移**不重建表**（只 ALTER + 回填），因为自动部署每 5 分钟就会用新代码打开旧库。

同一轮验证里还修了两件事：

1. **匿名核验其实一直在写历史**。`guarded()` 里 `userId: scope.key.replace(/^u:/, "")`
   会把 `anon:<hash>` 整串当成 userId（它不以 `u:` 开头，replace 什么也没剥掉），
   于是「匿名不落历史」的守卫根本不成立，库里留下 `user_id="anon:3e48ef9d22e0"`。
   改成 `scope.key.startsWith("u:") ? slice(2) : ""`，并加了护栏测试。
   这条只有真的发一次匿名请求、再去看库才会发现 —— 单测里都是 mock 的身份。
2. **最小字数两套标准**。匿名入口写「至少 60 字」，而 `verify-doc` 的正文门槛是 120 字，
   于是 60–119 字之间用户会拿到后端那句「正文不足 120 字」。统一成 `ANON_MIN_CHARS = 120`，
   前端 `MIN_CHARS` 跟同一个数。

### 22.8 已知局限（当天实测到的，不是设计意图）

- **中文近似标题不一定并簇**。Reuters「台积电 3nm 产能满载，苹果包下首批」与
  IT之家「台积电 3nm 产能已满 苹果拿下首批」的 token Jaccard 约 0.47，低于 0.5 门槛，
  于是同一件事被拆成两条事件。这个方向我选择**宁可少并**：误并会把两家不同的事说成
  「同一事件的两个说法」，那是替读者下结论；漏并只是少一条分支，页面上还有原文可点。
  `/e/*` 的「这一页怎么读」已经把这条写明。
- **分页游标按 `pub_at` 严格小于**，同一毫秒的多条在翻页边界可能被跳过。
  公开页一次读 120 条、接口上限 200 条，实际不会触发；真要修就得换成 (pub_at, id) 复合游标。
