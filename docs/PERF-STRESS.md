# 压测报告 · 2026-10-26

对线上同款机器（腾讯云广州 2 vCPU / 3.9GB / 5Mbps，Debian 12，Node 22.23.4，Next 16.4.2，
`--max-old-space-size=1024`）做的一次容量实测。**只发只读 GET**，唯一的写请求是我自己发的一条
匿名核验（额度内）和一个 12MB 的坏请求（验证 413）。时段选在业务低峰（03:0x–03:3x UTC）。

## 0. 怎么测的

三个视角，缺一不可：

| 视角 | 命令 | 说明什么 |
| --- | --- | --- |
| 应用本体 | `BASE=http://127.0.0.1:3215 CONCURRENCY=N DURATION_MS=8000 PATHS=/login,/entities /opt/node/bin/node scripts/loadtest.mjs` | 绕过 nginx 和上行，纯 Node 单进程能扛多少 |
| 边缘层 | `BASE=http://127.0.0.1` + `Host: ayuanjc.online` | nginx 缓存、limit_req、连接数 |
| 公网 | `BASE=http://106.52.116.164`（家里出口） | 用户真实体感，含 5Mbps 上行 |

`scripts/loadtest.mjs` 是仓库自带的那版（v2，按秒切窗），没改。

## 1. 结论

1. **单进程 SSR 稳态 ≈ 150 rps**（`/login`，c=20，连续 3 分钟，p50 126ms / p95 184ms / 0 错误）。
   8 秒短测只有 105–127 rps —— 那是 JIT 与缓存没热，短测会**低估**稳态。拐点在 c≈60 之后变平，
   c=100 开始崩：p50 1039ms、吞吐掉到 96 rps（排队把线程喂爆了）。
2. **真正的天花板是 5Mbps 上行，不是 CPU**。页面 gzip 后 9–11KB，公网实测 44 rps 就打满，
   p95 掉到 1.5s。现在这台机器舒服服务的规模是「20–40 人同时在线」，再往上先换带宽。
3. **静态资源完全不是问题**：nginx 缓存后 8956 rps / p50 4ms（50 并发，0 错）。Next 不在静态路径上。
4. **cron 抢同一线程的代价是 +38%**：cron 单次从 2.9s 变 4.0s，同一时刻 SSR p95 仍 300–450ms、
   没有 5xx。当前 5 分钟一轮的节奏可接受 —— 但别再往同一轮 cron 里加同步重活。
5. **内存没有泄漏迹象**：空闲 82.9MB → 压测峰值 239MB → 3 分钟浸泡稳定在 180MB 平台
   （上限 1GB）→ 停压后 181MB 不回缩（V8 保留堆，正常）。
6. **匿名核验的闸门是真的**：40 并发同时打，1 个 200、39 个 429；RSS 没涨；同一时刻
   `/login` 0.10s、`/entities` 0.05s —— 28 秒的模型/抓取在等 I/O，不吃事件循环。
7. **12MB POST 被 nginx 413 挡在门外**（裸 IP 与域名两条路径都挡），没进 Node。

## 2. 必须修的一件事：现在没有任何边缘限流生效

- 域名 `ayuanjc.online` 仍被腾讯云未备案拦截（`302 → dnspod.qcloud.com/static/webblock.html`），
  所以**现在 100% 的真实流量走裸 IP**。
- 裸 IP 命中 `/etc/nginx/sites-enabled/probe-temp-open`（`listen 80 default_server`），
  那份配置里**没有 `limit_req` / `limit_conn`**。
- 有限流的是 `probe-root`（`rate=10r/s burst=40`、`limit_conn 12`），但没人走得到它。

实测对照（同样 30 并发打 `/entities` 6 秒）：

| 命中哪台 server | 结果 |
| --- | --- |
| 裸 IP → probe-temp-open | 44 rps，**0 个 429**，全放行 |
| 域名 → probe-root | 199 个 429（limit_req 生效） |

也就是说：**备案期间任何人对裸 IP 打多少都不受限**，应用内部那套每分钟额度只覆盖部分 API。
修法（两行，选一）：

```nginx
# probe-temp-open 的 location / 里补上与 probe-root 相同的五行
limit_req zone=probe_rl burst=40 nodelay;
limit_req_status 429;
limit_conn probe_conn 12;
limit_conn_status 429;
```

或者临时只放行你自己的出口 IP（`allow x.x.x.x; deny all;`）。注意 `probe-temp-open` 本来就
写明了「备案提交前必须删掉」，删掉之后这条风险自然消失。

## 3. 数据

### 3.1 应用本体 · 并发扫描（loopback→3215，每个 8 秒）

| path | c | rps | p50 | p95 | p99 | 非 200 |
| --- | --- | --- | --- | --- | --- | --- |
| /login | 10 | 105.2 | 88 | 147 | 262 | 0 |
| /login | 30 | 124.8 | 232 | 308 | 327 | 0 |
| /login | 60 | 127.3 | 465 | 616 | 619 | 0 |
| /login | 100 | 96.3 | 1039 | 1314 | 1328 | 0 |
| /entities | 10 | 78.1 | 125 | 172 | 185 | 0 |
| /entities | 30 | 82.3 | 354 | 473 | 571 | 0 |
| /entities | 60 | 80.9 | 733 | 792 | 1685 | 0 |
| /entities | 100 | 53.7 | 1826 | 1996 | 2303 | 0 |
| /e/英伟达 | 10 | 98.9 | 95 | 153 | 165 | 0 |
| /e/英伟达 | 30 | 109.7 | 274 | 365 | 457 | 0 |
| /api/entity | 10 | 616 | 13 | 32 | 47 | 4634（**应用额度 300/分钟**，其余 429） |
| /api/entity | 30 | 748 | 34 | 73 | 104 | 全部 429 |

`/api/entity` 那两行值得单独看：**拒绝一次请求只花 34ms**，而放行一次要 13ms+ ——
限流器本身不是放大器的前提是它数字段判断，不是数字段 IO。

### 3.2 稳态 · c=20 连续 180 秒（/login，跑到被我叫停）

```
/login  n=27141  rps=150.7  p50=126  p95=184  p99=213  max=309  非200=0
```

### 3.3 边缘层

| 项目 | 数字 |
| --- | --- |
| 静态 chunk（nginx 缓存，50 并发 6s） | 55662 次，**8956 rps**，p50 4ms，p95 11ms，0 错 |
| 动态页面（域名路径 30 并发） | 38.8 rps（/entities），199 个 429 |
| 12MB POST | 413（两条路径都拦） |

### 3.4 公网（家里出口 → 106.52.116.164，裸 IP，6 秒）

| path | c | rps | p50 | p95 | p99 |
| --- | --- | --- | --- | --- | --- |
| /entities | 6 | 43.7 | 116 | 256 | 345 |
| /entities | 30 | 44.0 | 472 | 1529 | 2181 |

页面体积（raw / gzip）：

| 页面 | raw | gzip |
| --- | --- | --- |
| /login | 26352 | 9126 |
| /entities | 59641 | 10322 |
| /check | 24120 | 8824 |
| /e/英伟达 | 35400 | 11091 |
| 静态 chunk |  | 1975 |

5Mbps = 625KB/s；按 10KB 一页算理论上限 62 rps，实测 44 rps —— 差的那 30% 是 TCP/TLS 之外的
握手与并发窗口开销，属于正常损耗。**上行是硬边界**。

### 3.5 保底行为

| 场景 | 结果 |
| --- | --- |
| 40 并发匿名核验 | 1×200 + 39×429；RSS 77MB→72MB；同期 /login 0.10s、/entities 0.05s |
| cron 与 30 并发 SSR 同跑 | cron 4.02s（空闲 2.9s，+38%）；SSR rps 126、p95 354ms、0 个 5xx |
| 100 条空闲连接 | /login 仍 18→40ms，没有把服务拖死（nginx 侧空闲连接很便宜） |
| 压测中 cron 结束后 | 服务恢复 5.9ms（/login） |

## 4. 建议（按性价比）

1. **先加带宽**：5Mbps → 10Mbps，直接翻倍同时在线人数，比改代码便宜。
2. **把限流补到 default_server**（第 2 节两行），或者干脆等备案通过把 `probe-temp-open` 删掉。
3. **要突破 150 rps 只能多进程**，但有两个前提：
   - 进程内的每分钟额度会变成「每进程一份」，等于把额度乘了进程数 —— 得搬到 nginx（`limit_req` 已经能做）或共享存储；
   - SQLite 已经是 WAL + `busy_timeout=3000`，多进程写得住，但每实体/每关注的「上限裁剪」这类读后写在并发下会互相踩，得加事务或改成单写者。
   换句话说：**单进程够用，直到带宽或 150 rps 任一先到**。这就是 b6 的答案。
4. **cron 别再加重活**：现在抢线程已经要 38% 的额外时间，再加一轮同步解析就会开始影响 p95。

## 5. 测量偏差（别看错数字）

- 8 秒短测低估稳态（JIT/缓存未热），信 3 分钟那组。
- `loadtest.mjs` 收尾时 worker 直接退出，in-flight 请求被记成 `abort/error` —— 那是脚本自己的
  收尾，不是服务端错误（所以「非 200」列要连 statuses 一起看）。
- 公网测试都从同一个出口 IP 打，域名那台有 `limit_conn 12`，同一 IP 的并发会被自己人挤掉。
- 匿名核验只发了 41 次（40 并发 + 1 次单发），没有对模型侧做任何压力 —— 那条链路按次计费，
  压它等于烧钱，而它的瓶颈在外部 API 不在本机。

## 6. 复现

```bash
# 应用本体（服务器上）
cd /opt/probe/app
CONCURRENCY=20 DURATION_MS=180000 SERIES=1 BASE=http://127.0.0.1:3215 \
  PATHS=/login,/entities /opt/node/bin/node scripts/loadtest.mjs

# 公网体感（本机）
BASE=http://106.52.116.164 CONCURRENCY=6 DURATION_MS=6000 PATHS=/entities \
  node scripts/loadtest.mjs
```
