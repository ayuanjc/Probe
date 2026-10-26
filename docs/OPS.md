# 运维（OPS）：备份、存活探针、首屏体积、按人额度、CI

这份文档对应差距清单里的 P0 第 2–7 项。每一项都写清「它解决哪种具体的坏结果」，
因为这几件事的共同点是：**不做也不影响今天能打开网站**，只在出事那天才发现没做。

---

## 一、每日备份

### 为什么必须有

探针只有一个数据库（`.data/probe.db`，账号级历史），其余关键数据仍是单文件：

| 文件 | 丢了会怎样 |
| --- | --- |
| `/opt/probe/app/.data/auth/store.json` | 所有人被登出、管理员被重种（bootstrap 会用 env 里那组账号密码重建）、审计与封禁一起消失 |
| `/opt/probe/app/.data/consent/consent.log` | 协议同意留痕没了 —— 这是备案/隐私查验时要给的东西 |
| `/opt/probe/app/.cache/feedback.jsonl` | 用户反馈没了 |
| `/opt/probe/app/.cache/hn-history.json` | 热榜基线没了（只是首屏变慢，会自动重建） |
| `/opt/probe/app/.data/probe.db` | 所有人「我的历史」没了。账号、密码、会话不受影响（那些在 store.json） |
| `/opt/probe/probe.env` | 运行配置与所有 key（恢复时没有它，光有数据也起不来） |
| `/opt/probe/deployed-sha` | 不知道这份备份对应哪个提交 |

除 probe.db 之外这些文件都不是数据库，没有任何自带副本。手工 `cp` 靠人记得，靠不住。

### 它做了什么

脚本：`scripts/server/backup-probe.sh`（服务器上是 `/opt/probe/bin/backup-probe.sh`）

- 打包到 `/root/backups/probe/probe-YYYYmmdd-HHMMSS.tar.gz`，目录 `0700`、包 `0600`
- 只留最近 **14** 份（按修改时间，不按文件名 —— 跨年时按名字排序会留错）
- **三道校验**：`store.json` 必须在（少了就直接失败，绝不生成一个看起来成功的空备份）；
  `tar -tzf` 必须能读（截断的包只在解包时才报错，那时已经晚了）；`store.json` 必须是合法 JSON；
  备份里的 `db/probe.db` 必须通过 `PRAGMA integrity_check`
- `probe.db` **不直接拷文件**：WAL 模式下最新写入还在 `-wal` 里，只拷 `.db` 会少最近的数据，三件套一起拷又可能在别人写入时得到互不自洽的一套。脚本用 sqlite3 的在线备份 API（python3 自带）取一份一致快照；取不到时打印警告并退回直接 `cp`（可能缺最近几条历史，但至少不中断备份）
- 每次追加一行到 `/root/backups/probe/index.txt`

定时：`probe-backup.timer` → 每天 `03:20`，`RandomizedDelaySec=600`（避开整点），`Persistent=true`（机器关过一天，开机补跑）。

### 恢复（出事时照着敲）

```bash
systemctl stop probe-web.service            # 必须先停：应用在写的时候覆盖文件会被它写回去
cd /root/backups/probe && ls -1t | head     # 选一份
tar -xzf probe-<时间戳>.tar.gz -C /root/restore-$(date +%s)
# 校验一下解出来的东西对不对
python3 -c 'import json;print(len(json.load(open("/root/restore-*/auth/store.json"))["users"]),"users")'
install -o root -g root -m 600 /root/restore-*/auth/store.json     /opt/probe/app/.data/auth/store.json
install -o root -g root -m 600 /root/restore-*/consent/consent.log /opt/probe/app/.data/consent/consent.log
# 历史库：**先删掉 -wal / -shm**，否则旧 WAL 会被当成「更新的数据」重放到刚恢复的库上
install -o root -g root -m 600 /root/restore-*/db/probe.db /opt/probe/app/.data/probe.db
rm -f /opt/probe/app/.data/probe.db-wal /opt/probe/app/.data/probe.db-shm
systemctl start probe-web.service
curl -sS http://127.0.0.1:3215/api/version       # 起来了再看登录
```

> 恢复是**整份覆盖**：备份之后新注册的账号会消失。要合并两份 store.json 就手工改，
> 注意 `sessions` 里的 token 是哈希、`invites` 有 `usedBy`，别把同一份数据写成两条。

### 还差什么

备份和网站同机。**整台机器挂掉时备份一起没**。真要防这一层，得把 tar 包同步到对象存储
（腾讯云 COS / 另一台机器 `rsync`）。这一步需要一把 COS 密钥，没做。

---

## 二、存活探针（自愈 + 告警）

脚本：`scripts/server/healthcheck-probe.sh`（服务器 `/opt/probe/bin/healthcheck-probe.sh`）
定时：`probe-health.timer` → 每 2 分钟，`OnBootSec=2min`。

### 查什么、为什么是这几项

| 检查 | 对应的真实故障 |
| --- | --- |
| `systemctl is-active probe-web` | 进程没了。**先自动 `restart` 再看结果** —— 半夜挂掉时先救活比先吵醒人有意义 |
| `GET /api/version` 且响应含 `buildId` | 端口开着不等于能用：next 可能活着但每次请求都 500。**判据是包内容，不是状态码**（`/api/version` 不回 `ok` 字段，曾经写成找 `"ok":true` 于是永远误报） |
| 根分区使用率 ≥ 90% | 写满后 `.data` 写入失败 → 所有人登不上，且恢复要停服 |
| `MemAvailable` < 150MB | 4G 机器 + `MemoryMax=1200M` 的 node，OOM 会先杀它 |
| `NRestarts` 两次检查间增长 ≥ 3 | `Restart=always` 会把崩溃藏起来：网站一直能访问，但其实一直在挂 |

### 告警通道

在 `/opt/probe/probe.env` 里加一行（任意接受 `POST {"text":"..."}` 的地址都行：
Server酱 / PushPlus / 钉钉或企业微信机器人中转 / 自建都吃这个形状）：

```bash
PROBE_ALERT_WEBHOOK=https://...
```

- 没配 → 只写 `/var/log/probe-health.log`，**但日志里明确写 `ALERT`**，不会静默
- 同类告警 **30 分钟只发一次**（状态在 `/run/probe-health/<key>`，重启机器后重来）
- 日志自己轮转：超过 2MB 就只留最后 2000 行

### 演练（不碰线上服务）

```bash
PROBE_HEALTH_URL=http://127.0.0.1:9/api/version \
PROBE_ALERT_WEBHOOK=http://127.0.0.1:8899/alert \
  /opt/probe/bin/healthcheck-probe.sh; echo rc=$?
```

用一个死端口冒充服务，就能把「判定失败 → 告警 → 去重」整条链路走一遍，
不需要真把线上停掉。`rc=1` 表示这一轮有检查没过；`systemctl status probe-health` 里
也会显示 `failed`，这是有意的 —— `systemctl --failed` 应该能看见它。

### 还差什么

这是**机器内部**的探针：它能发现「进程死了 / 应用 500 了 / 磁盘满了」，
发现不了「这台机器整台没了 / 防火墙拦了 / 备案被拦」。那需要外部监控
（腾讯云云监控的站点拨测，或 UptimeRobot 免费版），从公网每分钟敲一次。
那份配置在控制台，不在代码里，需要人工点。

---

## 三、首屏体积（P0 第 5 项）

### 先纠正一个数字

之前我说「首屏 1.6MB JS，在 5Mbps 上要 2.5 秒」——那是按**原始字节**算的。
nginx 是开 gzip 的（`/etc/nginx/nginx.conf` 第 64–69 行，level 5，`min_length 512`，
`types` 含 json/js/css/svg），实际传输的是压缩后的字节：

```
npx next build && node scripts/size-report.mjs
```

| 路由 | 同步 chunk | 原始 | gzip |
| --- | --- | --- | --- |
| `/` | 3 | 521KB | **166KB** |
| `/account` | 2 | 47KB | 16KB |
| `/metrics` `/verify` | 2 | 43KB | 15KB |
| `/login` `/signup` | 2 | 40KB | 13KB |
| `/privacy` `/terms` `/terms/en` | 1 | 33KB | 11KB |

166KB gz 在 5Mbps 上约 0.27 秒。**带宽不是墙**，所以「为了省流量去拆 framer-motion」
这件事被否掉了：改造面大（`Workspace.tsx` 里 15 处 `motion.*` + `ModuleCard.tsx`），
只省约 30KB gz，收益不抵风险。

### 真正削掉的是 ECharts

原来 `src/components/ChartBox.tsx` 里 `dynamic(() => import("echarts-for-react"))`
拉的是**整包 ECharts**：

| | 原始 | gzip |
| --- | --- | --- |
| 改前 | 1122KB | 370KB |
| 改后 | 777KB | **256KB** |

做法（`src/components/EChart.tsx`）：

- `echarts/core` + `echarts-for-react/lib/core`，用 `echarts.use([...])` 只注册用得到的部分
- 注册的图表类型对着 `src/lib/compile.ts` 逐个核过：pie / treemap / scatter / heatmap /
  radar / graph / funnel / gauge（line、bar 是备用）；组件只要 Grid / Tooltip / Legend /
  Title / Dataset / Transform / VisualMap / MarkLine / Graphic + CanvasRenderer
- 这些 chunk 是**异步**的：首屏不付这份钱，出第一张图才付。所以它对「首屏」没影响，
  真正的收益是「图表出现的那一刻少下 114KB gz」

**新增图表类型时必须去 `EChart.tsx` 的 `echarts.use([...])` 里补注册**，否则图上会是空白
（不报错 —— ECharts 对未注册的 series 只是不画）。这是这套做法的唯一代价。

---

## 四、按人额度（P0 第 6 项）

### 原来的问题

`PROBE_DAILY_LLM_CALLS`（默认 2000）是**进程级**计数器：一个登录用户连点十几次
「生成面板」，或者跑一轮文档核验（几十次上游调用），就能把它用光 ——
然后**所有人**一起降级到本地模板，日志里只有一行「今日调用已达上限」，看不出是谁。

### 现在的两道闸

| 闸 | 环境变量 | 默认 | **生产现值** | 单位 |
| --- | --- | --- | --- | --- |
| 全局 | `PROBE_DAILY_LLM_CALLS` | 2000 | **800** | 上游调用次数 / 整个进程 / 天（钱） |
| 按人 | `PROBE_DAILY_LLM_UNITS_PER_USER` | 30 | **60** | **点** / 每个账号 / 天 |

> 2026-10-25 起按 YG 要求调成 800 / 60（写在 `/opt/probe/probe.env`，`chmod 600`）。
> 后台「额度设置」页写出的 `.data/ops/limits.json` **优先于** env —— 在界面上改过之后，
> 改 env 不再生效，要先删掉那个文件（`rm -rf /opt/probe/app/.data/ops`）并重启。
> 老变量 `PROBE_DAILY_LLM_CALLS_PER_USER` 仍然被读取（值当「点」解），升级不会让线上那行静默失效。

### 两道闸的单位不一样（这是有意的）

| | 单位 | 为什么这么算 |
| --- | --- | --- |
| 全局 | 一次上游调用算 1 | 这里管的是钱，按真实支出记才对得上账单 |
| 按人 | 一次**操作**算点：提问 1 / 生成面板 1 / 文档核验 3 | 用户点的是「核验这篇文章」，不是「那二十四次调用」 |

按调用次数给个人记账的问题是：一次核验内部最多 24 次调用（12 段抽取 + 12 条判定），
按调用记会让用户觉得「核验一次吃掉八次提问的额度」，而且**经常跑到一半被拦**，
界面上看起来像故障。现在一轮核验固定 3 点，60 点够 20 轮完整核验。

记点在**操作开始**时发生（`chargeOperation(OP_UNITS.verify)` 之类），实现在
`src/lib/llm.ts`：`OP_UNITS = { search: 1, module: 1, verify: 3 }`。

- 余额还够 → 照常跑；用满的那一次**仍然放行**（否则「额度刚好用完」的最后一轮会莫名变成本地模板）
- 余额已用完 → 这一次**也放行**，但把该账号标成 `blocked`，之后每一次上游调用都返回 false（整轮降级成本地模板），界面标 `llm:user_budget`
- 为什么不直接拒掉请求：用户点的是「核验这篇文章」，拒掉等于页面什么都没发生；照出结果 + 标注降级，比静默失败诚实
- 点数被夹在上限上，一直点也不会涨成天文数字（后台进度条才好读）
- 后台表格同时显示两个数：**今日额度（点）** 是判定依据，**上游调用** 是实际打了几次，差得多说明这条链路重

### 一道核验有多贵（要知道的代价）

`/api/verify` 的上限是 12 段抽取 + 12 条判定（`MAX_SEGMENTS_EXTRACT` /
`MAX_CLAIMS_VERIFIED`，见 `src/agents/verify-pipeline.ts`），也就是**一次核验最多 ~24 次上游调用**，
按点算是 3 点。所以**按人 60 点 ≈ 20 轮完整核验**，或 60 次提问，或两者混着来。
全局 800 次/天按「提问 2–3 次上游、核验 24 次」折算，大约够 60 轮核验或三百次提问 ——
先撞到的通常是全局那道闸。

顺序也要留意：全局那道闸在个人之前判，全局耗尽时所有账号一起停；
**个人被拦时不消耗全局额度**（否则一个人狂点会让全站提前降级）。
和以前不同的是：个人这道闸现在是「操作开始时记点、余额不足就标记 blocked」，
不再在每个上游调用上比次数。

实现要点：

- 身份用 `AsyncLocalStorage`（`src/lib/call-scope.ts`）。SSE 的 `start()` 可能在路由
  函数返回**之后**才跑，请求上下文已经没了 —— 所以 `/api/search`、`/api/verify`、
  `/api/module` 都在 `start()` 内部**重新绑一次** scope，否则这一轮调用会算到「无主」头上
- 额度按 `user.id` 算，不按 IP：同一账号换 IP 也跑不掉
- 用户自带 key（设置面板填的 / 请求头带的）**不计额度** —— 花的是他自己的钱
- 表有上限（2048 键），满了先清隔天的，还满就整体清空。清空的代价只是「有人今天多拿一次额度」
- 额度用完时降级会带 `llm:user_budget`，界面文案是
  「你今天的调用额度已用完，本轮改用本地模板，额度次日重置」


### 后台改上限（不用登服务器）

`/ayuanjc` → 左侧「额度设置」：改全局 / 每人上限、看今天各账号用掉多少、一键清掉覆盖。

- 写进 `/opt/probe/app/.data/ops/limits.json`（0600），**优先于环境变量**；「清除覆盖」即回到 `probe.env` 的值
- 为什么落盘而不是只改内存：服务器每 5 分钟自动部署重启一次，只改内存的上限活不过一次部署
- 文件缺失 / 被手改坏 → 一律按「没覆盖」回落 env。额度是限制，不能因为读不到配置就变成 0（那等于全站降级）
- 0 / 负数 / 小数 / 超界在路由与 `llm.ts` 各夹一次，写不出「0 次/天」
- 每次改动记一条审计：`quota.update`（`global=… perUser=…`）
- 面板上的用量是**进程内存**里的计数，服务重启归零；上限不会

同一页签的「设置」分两半：

**能写的两件**（都不碰进程环境，改完立刻生效）：

- 账号密码：选账号 → 输新密码 → 勾不勾「要求他下次登录时改掉」。
  走 `PATCH /api/admin/users` 的 `newPassword`，规则/强制改密/撤销该账号全部会话/审计
  都在 `src/lib/auth/account.ts`；改自己会把自己踢下线。
- 额度上限：与「额度设置」页**共用同一个组件**（`QuotaCaps.tsx`）与同一个
  `POST /api/admin/ops`。两处各写一份输入框迟早出现一边忘了夹上限。

**只读的一半**：模型端点、区域判定、检索源配没配、备案号、鉴权模式 —— 这些是进程启动时
读到的环境变量。故意只读：能从浏览器改这些，等于拿到 admin 就能关掉鉴权、换掉模型端点。
要改就编辑 `/opt/probe/probe.env` 再 `systemctl restart probe-web`。
---

## 五、CI（P0 第 7 项）

`.github/workflows/ci.yml` 两个 job：

1. `test`：`npm ci` → `npm run typecheck` → `npm test`（328 条）
2. `build`：`npm ci` → `npm run build` → **smoke** → **fuzz**

smoke 为什么必须有：构建能过 ≠ 能启动。缺一个运行时 env、Server Component 里抛错，
都只会在 `next start` 之后才炸。它真起一次服务，然后：

- `/login` `/privacy` `/terms` `/api/version` 必须 200
- `/api/admin/users` 未登录必须 **401**（权限闸真的在跑，不是 200）
- 隐私页 HTML 里必须能找到 `粤ICP备…`（页脚备案号是备案验收项，缺了会被驳回）

注入的测试备案号是假的（`粤ICP备00000000号-1`），只用来断言「渲染链路通」。

### fuzz 也是门禁，不只是报告

`scripts/probe-fuzz.mjs` 用 389 条畸形请求打全部 API，失败口径只有两条：
**5xx 裸栈**、**4xx 但返回的不是 JSON**。它在 smoke 起的那台服务上跑（`STRICT=1`），
所以「坏输入把进程打崩」「错误体退化成 HTML」这两种退化会在 push 时就被拦住。

脚本必须能判 PASS，否则它没用。所以它显式列出「已解释的非 2xx」：

- `framework_405_empty`：路由没导出该方法时 Next 自己回的空体 405。**会被人误发的那些**
  （`dossier`/`evidence`/`translate`/`module`/`feedback`/`login`/`password`/`logout` 的 GET）
  自己导出了 `methodNotAllowed()`，回结构化 405 + `Allow` 头；剩下的 DELETE/PUT 纯属畸形请求，
  交给框架。
- `cron_disabled`：没配 `PROBE_CRON_SECRET` 时 cron 端点保持关闭，回结构化 503 —— 设计如此。

当前基线：`4xx 238 / 2xx 141 / 5xx 10`（全是上面那 10 条 cron），已解释 13 条，**PASS**。

---

## 六、现在还没做的

| 项 | 卡在哪 | 下一步 |
| --- | --- | --- |
| HTTPS（第 2 项） | 备案期域名被云侧阻断：任何公网 HTTP 请求都被 302 到 `dnspod.qcloud.com/static/webblock.html`，Let's Encrypt 的 HTTP-01 校验够不到 nginx | 要么在腾讯云控制台签免费 DV 证书（DNS 校验，域名已在 DNSPod，界面点几下）再拿 nginx 格式的证书给我装；要么给一把 DNSPod API token，我用 acme.sh 的 DNS-01 全自动签发 + 自动续期 |
| 境内检索源（第 1 项，本轮跳过） | 博查 key 欠费 403 `You do not have enough money or package quota` | 充值，或接第二家境内搜索 API |
| 备份异地 | 需要 COS 密钥 | 上对象存储后把 tar 包同步过去 |
| 外部拨测 | 控制台操作 | 腾讯云云监控站点拨测 / UptimeRobot，每分钟敲一次 `/api/version` |
---

## 七、反馈文件与抓取面

### 反馈不再是「满了就拒收」

上一版到 `PROBE_FEEDBACK_MAX_BYTES`（默认 8MB）就回 503 停止接收。守上限本身没错，
错在后果：**守着上限拒收等于让后面所有人的意见静默消失** —— 提反馈的人只看到一句
“存储已满”然后走掉，而运维也不一定那天恰好登录。

现在（`src/lib/feedback-store.ts`）：

| 行为 | 说明 |
| --- | --- |
| 到阈值就归档 | 当前文件改名进 `.cache/archive/feedback-YYYYMMDD-HHmmss.jsonl`，新文件从零继续收，请求照常成功 |
| 归档有保留份数 | `PROBE_FEEDBACK_KEEP_ARCHIVES`（默认 10），超出按时间删最旧 → 磁盘占用仍有上界 |
| 同秒两次归档不覆盖 | 文件名自动加 `-2`/`-3` 后缀，宁可多一个文件也不丢一份数据 |
| 全程同一临界区 | 「看大小 + 归档 + 追加」在一条 Promise 链里，进程内并发不能各自看到“还没满”再一起写 |

运维读法不变：`tail -n 20 .cache/feedback.jsonl` 看最新的，`ls -lt .cache/archive` 翻旧的；
真要腾空间就删 archive 里最老的那几份（主文件不要删，正在写）。
归档发生时服务日志有一行 `[feedback] … 归档为 archive/feedback-…jsonl`，
`journalctl -u probe-web.service | grep feedback` 就能看出「一天满了几次」。

### robots.txt 与 sitemap.xml

两者都由代码生成（`src/app/robots.ts`、`src/app/sitemap.ts`），不是 `public/` 里的静态文件 ——
这样地址永远跟着 `PROBE_SITE_URL` 走，换域名只改一处环境变量。

- **允许**抓的：`/`、`/login`、`/signup`、`/privacy`、`/terms`、`/terms/en`。
- **拒绝**抓的：`/api/`（全是 JSON）、后台（用 `ADMIN_PATH` 常量，不写死路径）、`/account`、`/metrics`、`/verify`。
- sitemap 只列**陌生人无登录就能看到**的页面。首页与 `/verify` 都是登录墙（会 307 到 `/login`），
  放进 sitemap 等于让爬虫抓到五个一模一样的登录页、把权重摊薄，所以不列。

改域名/加页面时：域名只改 `PROBE_SITE_URL`；新页面决定「要不要给爬虫看」，要给就加进 `src/app/sitemap.ts`。
---

## 八、错误账本（后台「设置」页的「最近的错误」）

以前 5xx 只回一句公共文案（上游原话里可能带内部地址、模型名、响应体片段，不能给浏览器），
真正的原因只在 journald 里 —— 想看「最近半小时是哪一类错误在冒」得先 ssh 上去 grep。
现在 `jsonError()` 在返回 5xx 时顺手记一条到进程内的环（`src/lib/error-log.ts`），
后台「设置」页直接列出来。

| 事项 | 口径 |
| --- | --- |
| 记什么 | 状态码、code、**回给客户端的那句公共文案**（截 300 字）、归属（登录用户标签 / 无主） |
| 不记什么 | 原始异常对象、堆栈、上游响应体 —— 否则密钥与内网地址会顺着面板漏出去 |
| 只记 5xx | 4xx 是调用方的问题，记进来会把真正要修的信号淹掉 |
| 容量 | 最近 200 条，进程重启归零；`total` 是启动以来的累计条数 |
| 更早的 | `journalctl -u probe-web -n 200`、`/var/log/probe-health.log` |

看面板的顺序建议：先看 `byCode` 那行是不是**同一类 code 在反复冒**，
再看「额度设置」是不是额度耗尽导致的降级（那不是错误），最后才去翻 journald 找原始堆栈。
---

### 今天有人在用吗（后台「设置」页的「今天的操作」）

三个数字之外的东西都不是埋点：

| 看到什么 | 说明 |
| --- | --- |
| 提问 / 文档核验 / 追加面板的次数 | 真实入口各记一次（`recordOp`）。额度用尽时也照记 —— 额度是闸，计数是负载 |
| 导入 / 导出次数 | 只用来判断「有人搬历史」和「有人导出过数据」 |
| 降级原因 Top N | 从 trace 里折出来的类别，不是原始机器码（`claims:quote_miss_3` 与 `_4` 算同一类） |

几条边界：

- **不记是谁、也不记问了什么。** 人脸与提问原文在 `probe.db`（见第十节），面板这一块只数次数。
- 进程内存：**重启归零、跨天归零**。它回答的是「今天」，历史趋势看 `probe.db` 或 journald。
- 类别上限 60，超出的并入 `other`；但 `degradedTotal` 永远是完整的 —— 显示可以截断，总数不行。
- 降级 ≠ 故障：没配检索源、额度用尽、上游不支持 `json_schema` 都会走到本地模板。某一类忽然变多，先看「检索源」那栏有没有「缺」，别先怀疑代码。

## 九、容量实测（2 核 4G / 5Mbps 那台）

`scripts/loadtest.mjs` 只打**不花钱**的端点。为什么不压 `/api/search`：一次提问 = 2–3 次上游 LLM 调用
+ 一次检索，压出来的是「上游多久回」，不是「这台机器能扛多少」。钱和延迟都不在这台机器手上。

```bash
# 在服务器本机（绕过 nginx 与云侧阻断，测的是 Node 本身）
BASE=http://127.0.0.1:3215 CONCURRENCY=20 DURATION_MS=12000 /opt/node/bin/node scripts/loadtest.mjs
```

2026-10-25 实测（node 22.23.4，Next 16 生产模式，`next start -H 127.0.0.1 -p 3215`）：

| 端点 | 并发 | RPS | p50 | p95 | p99 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| `/api/version` | 20 | 653 | 26ms | 60ms | 91ms | 纯 JSON，几乎只剩 Node 的序列化 |
| `/api/version` | 60 | 818 | 63ms | 126ms | 191ms | 仍在涨，说明没到墙（压测端单进程先到） |
| `/robots.txt` | 20 | 870 | 19ms | 42ms | 66ms | 同上 |
| `/login` | 20 | 133 | 146ms | 197ms | 275ms | SSR 渲染，**这就是墙** |
| `/login` | 60 | 135 | 451ms | 552ms | 584ms | RPS 不再涨 = 2 核跑满 |
| `/` | 20 | 133 | 143ms | 206ms | 258ms | 307 到 /login，同样受 SSR 约束 |
| `/api/region` | 20 | — | — | — | — | 60 次后全是 429（`PROBE_REGION_RATE_PER_MIN` 默认 60），设计如此 |

读法：

- **真正的容量上限是 SSR 页面 ≈ 135 rps**（约 8000 次/分钟），一次性并发 60 时 p95 552ms 仍可接受。
  这个量级的邀请制工具到不了，所以现在不需要做 ISR、缓存 HTML 或上 CDN。
- **静态资源不受 Node 约束**：`/_next/static/` 由 nginx 直接发（7 天 immutable），5Mbps 约 625KB/s，
  首屏 166KB gz ≈ 0.27s。带宽是第一个会撞的资源，不是 CPU —— 但只有真有人来才撞得到。
- **钱和上游延迟是另一条线**：全局 800 次调用/天（≈300 次提问或 60 轮核验）先撞闸，
  那时页面会降级成本地模板并标 `llm:user_budget`，不是 500。

什么时候该重跑：换机型、改 Next 主版本、加新的首屏 Graph/图表、或日活过百。

### 2026-10-26 复测：加了中文源与国内榜单之后

上一张表是只有 HN 时测的。这轮补了中文科技前沿（IT之家 / 少数派）和国内热议（百度 / 掘金），
重测一遍看有没有被拖慢。压测脚本升级成 v2（`scripts/loadtest.mjs`，v1 的无序列版本已被替换），
多两件事：按 1 秒切桶输出时间序列（分位数会抹平一两秒宽的尖刺），以及支持 `COOKIE=` 带登录态压首屏。
采样脚本入库为 `scripts/server/sample-proc.sh`，服务器上直接 `sh scripts/server/sample-proc.sh <pid> 50`。

表中「长测」= 60 秒 20 并发。**短测（15 秒）的 /login 只有 125 rps，是 JIT 预热没跑完，不要拿它当容量。**

| 端点 | 并发 | 时长 | RPS | p50 | p95 | p99 | 对照 10-25 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `/api/version` | 20 | 15s | 654 | 25ms | 64ms | 97ms | 653 → 没变 |
| `/api/version` | 60 | 15s | 818 | 65ms | 126ms | 163ms | 818 → 没变 |
| `/login` | 20 | 15s | 125 | 153ms | 218ms | 335ms | 预热不足，见长测 |
| `/login` | 60 | 15s | 132 | 446ms | 599ms | 701ms | 135 → 没变 |
| `/`（全 307） | 20 | 10s | 132 | 148ms | 205ms | 221ms | 133 → 没变 |
| `/login` **长测** | 20 | 60s | **153** | 125ms | 180ms | 203ms | — |
| `/login` + cron 中途触发 | 20 | 60s | 149 | 127ms | 192ms | 238ms | — |

结论：**墙没动**。轻端点、SSR 页面、307 跳转三档与 10-25 的差异都在噪声里，
中文源和榜单是「读缓存 + 拼装」，不占 SSR 时间。长测给的 153 rps 才是这台机器的真实 SSR 上限。

### 单进程到底用了多少（CPU / 内存）

压测期间每秒读一次 `/proc/<pid>/stat` 与 `ps -o rss=`（脚本 `/tmp/sample.sh`，
注意 comm 是 `next-server (v16.4.2)` 带空格，awk 切词会整体右移一位，utime/stime 要取 `$15/$16`）：

| 指标 | 数值 |
| --- | --- |
| 稳态 CPU（20 并发持续压 SSR） | **100–130%**，峰值 133% |
| 相当于这台 2 核机器的 | 约 1.1 核，峰值 0.67 台 |
| RSS | 212768KB → 263888KB（207MB → 258MB），前 40 秒涨 50MB 后走平 |
| loadavg（2 核） | 1.5–2.2 |

读法：**单进程没有把两个核用满**。Next 的 SSR 是单线程事件循环，100–130% 说明它已经
基本吃满一个核、另一核只分担了 GC 与 libuv 线程池，再多并发也不会变快（60 并发 132 rps 即是证据）。
RSS 涨 50MB 是压测时 Next 的路由/渲染缓存被填满，走平后不再涨 —— 不是泄漏，但如果持续压一小时
要复测一次（4G 内存给 258MB 留的余量很大，撞不到）。

### cron 会不会插队（这条原来是猜的，现在有数）

担心的是：`probe-heat.timer` 每 47 分钟跑一轮 cron，要抓 HN + 百度 + 掘金 + IT之家 + 少数派
五路，还要写 SQLite —— 单进程模型下会不会卡住正在答题的人。

实测：60 秒稳态压 SSR，第 20 秒触发一次真实的 `/api/cron/heat`（`http=200 t=4.21`），
逐秒数据是：

```
t=19s cpu=110% rss=258440kb   ← cron 起跑前
t=20s cpu=114% rss=260024kb   ← cron 起跑
t=21s cpu= 97% rss=260024kb
t=22s cpu=108% rss=261344kb
t=23s cpu=118% rss=266120kb
t=24s cpu=108% rss=260496kb   ← cron 结束（4.2s）
t=25s cpu=109% rss=260496kb
```

同时段每秒完成请求数 160/144/160/160/145/166，p95 142–192ms —— **没有可见尖刺**。
原因很朴素：cron 的四秒里绝大部分时间在等上游 HTTP 回来，那是异步 IO，不占事件循环；
解析几十 KB JSON 和写几条 SQLite 加起来只有几十毫秒。

所以**不需要为定时任务做双进程或队列**。真要担心的是上游同时 5 路超时（各 8 秒），
那会有 5 个待决 promise 挂着 —— 仍然是内存与连接数问题，不是 CPU 问题。

### 带宽才是第一个撞的墙（算一遍）

`node scripts/size-report.mjs`（首屏同步 chunk 的 gzip 体积）：

```
/            3 sync chunks   531KB gzip   168KB
/login       2 sync chunks    42KB gzip    14KB
```

5Mbps = 625KB/s ÷ 168KB ≈ **3.7 个首屏/秒**。而 SSR 能出 153 个首屏/秒，
要跟上得 25MB/s ≈ 200Mbps —— **差 40 倍**。

也就是说这台机器先撞的既不是 CPU 也不是 Node，是带宽，而且撞得很早：
十几个真人同时打开首页（每人 168KB，且 `/_next/static/` 的 JS 也被 nginx 一起发）
就能把 5Mbps 吃满，表现为「点开转圈」而不是「500」。

当前规模（邀请制，日活个位数）离这条线很远，所以维持现状。真要往上走，顺序是：

1. 先开 CDN 或 COS 托管 `/_next/static/`（静态资源占首屏的大头，且可长期缓存）；
2. 再把 5Mbps 升到 10–20Mbps（腾讯云按带宽计费，这一步最直接）；
3. 最后才谈多进程 / 多机 —— 那时反而是 CPU 可以先撑住的。

### 这些数字什么时候会过期

重跑的触发条件与上面一样，另外补两条：**换 Node 主版本**、**首屏新增第三方脚本或图表**。
重跑时先 `scp scripts/loadtest.mjs scripts/server/sample-proc.sh` 到服务器，再取 PID：
`ps -eo pid,args | grep next-server`。**别用 `pgrep -f next-server`** —— 它在非交互 ssh shell 里
有时返回空，于是采样脚本会输出一排 `cpu=0% rss=0kb`；那不是机器闲，是根本没采到（采样脚本现在
对空 PID 会直接报错退出，不再静默输出 0）。

---

## 十、账号级历史（probe.db）

设计稿在 `docs/DESIGN-b2.md`，这里只写值班时要用的部分。

### 它是什么

一个 SQLite 文件：`/opt/probe/app/.data/probe.db`（默认目录跟 store.json 同源，`PROBE_DATA_DIR`）。
**账号、密码、会话、审计一律不在这里**（仍在 `.data/auth/store.json`）—— 历史库坏掉的最坏结果是
所有人看不到自己的历史，登录与后台不受影响。这一点是有意设计的：一个坏掉的库不该把所有人挡在门外。

| 表 | 存什么 |
| --- | --- |
| `queries` | 一行一次查询：提问原文（可关）、区域、模型端点、意图类别、实体、摘要长度、三态计数、降级项、信源数/域名、文档哈希、耗时、时间窗 |
| `query_sources` | 每次查询对应的信源 URL/标题/来源/引文哈希（引文只存哈希，不存原文） |

**不存正文、不存模型输出全文。** 摘要只存字符数（`summary_len`），所以即使库泄露也拼不出当时说了什么。

### 三个开关（都在 probe.env）

| 变量 | 默认 | 关掉会怎样 |
| --- | --- | --- |
| `PROBE_HISTORY_SERVER` | `1` | 整个功能关闭：接口返回 `enabled:false`、/account 不出面板、不再写入也不再清理 |
| `PROBE_HISTORY_STORE_QUERY` | `1` | 仍然记录（时间/信源/统计都在），只是提问原文落库为空串，界面显示「这件功能当时关着原文保存」 |
| `PROBE_HISTORY_RETENTION_DAYS` | `30` | 过期行由 `pruneExpired()` 删除；改小之后**不会立刻少**，要等下一次清理（见下）。改默认值时也要把已写入的 `expires_at` 一起收紧，否则老数据还按旧天数活着（见下） |

### 把保留期从 90 收到 30 之后（一次性动作）

默认值改了只影响**新写入**的行 —— `expires_at` 是写入时算好的字段，老行还按旧天数活着。
2026-10-26 把默认从 90 改成 30 时，线上存量用这一条夹紧（幂等，可以重复跑）：

```bash
sqlite3 /opt/probe/app/.data/probe.db \
  "update queries set expires_at = min(expires_at, created_at + 30*86400) where expires_at > created_at + 30*86400;"
sqlite3 /opt/probe/app/.data/probe.db 'select count(*) from queries where expires_at is null or expires_at < created_at;'   # 期望 0
```

跑完不用等清理 —— 下一轮 `/api/cron/heat` 的 `pruneExpired()` 就会把已经过期的行删掉，
`historyPruned` 会明显大一次。**别在备份期间跑**（备份脚本取快照时会短暂持锁，等它跑完）。

清理时机：挂在已有的热榜定时任务里（`/api/cron/heat` 成功时顺手删一批，`historyPruned` 是这一轮删的行数）。
没有单独起 timer —— 多一个 timer 就多一处会坏的东西。所以`probe-heat.timer` 停了，过期行也不会减少。

### 值班常看的几件事

```bash
# 库多大、有多少行（WAL 存在时 page_count 会略偏小，属正常）
ls -l /opt/probe/app/.data/probe.db*
sqlite3 /opt/probe/app/.data/probe.db 'select count(*) from queries; select count(*) from query_sources;'

# 完整性（备份脚本也会跑这个）
sqlite3 /opt/probe/app/.data/probe.db 'PRAGMA integrity_check;'

# 谁用得最多（按人看用量，排查「某人把额度烧光」）
sqlite3 /opt/probe/app/.data/probe.db 'select user_id, count(*) c from queries group by user_id order by c desc limit 10;'
```

### 出问题怎么退

- **写不进去**：日志里搜 `[history]`。写入失败只 `console.warn`，**不会**影响已经上屏的结果（`persistQuietly` 是最后一步，吞异常）。
  真修不了就 `PROBE_HISTORY_SERVER=0` 重启，功能整体消失但站点照常。
- **库坏了**：停服务 → 把 `probe.db*`（含 -wal/-shm）改名挪走 → 起服务。代码会重新建一个空库并跑迁移。
  **不要只挪 .db**：残留的 WAL 会被当成更新的数据重放，症状是「明明删了又回来了」。
- **想彻底清除某个人的历史**：后台没有入口（刻意的，避免误删）。手工 `delete from query_sources where query_id in (select id from queries where user_id='...'); delete from queries where user_id='...';`

### 还没做（写在这里免得当成忘了）

- 异地备份：和 store.json 一样，备份包目前只在同机 `/root/backups`（见第一节「还差什么」）。
- 账号注销清空历史：auth 侧没有注销入口（自助注销要动密码复核 + 会话吊销，属产品决定），
  所以现在走隐私政策里写的那条人工路径。

### 全站关停 / 彻底清空（第三条删除路：整台机器不要了）

按人删、按时间过期之外，还有第三种情况：**这个站不做了**。顺序不能乱，乱的后果是
「服务器停了但备份还活着」—— 用户被承诺的删除只做了一半。

```bash
# 0) 先停写入，再谈删。cron 还在跑的时候删库等于边写边删。
systemctl stop probe-heat.timer probe-update.timer
systemctl stop probe-web

# 1) 库与缓存（历史、关注、命中、中文源基线、反馈）
rm -f /opt/probe/app/.data/probe.db /opt/probe/app/.data/probe.db-wal /opt/probe/app/.data/probe.db-shm
rm -f /opt/probe/app/.cache/cn-history.json /opt/probe/app/.cache/hn-history.json
rm -f /opt/probe/app/.cache/feedback.jsonl

# 2) 账号与会话（store.json 里是 scrypt 哈希 + 会话/邀请码的 SHA-256，仍然是个人数据）
rm -f /opt/probe/app/.data/auth/store.json

# 3) 备份包：**这一步最容易被忘**，忘了前面全白做
rm -rf /root/backups/probe

# 4) 核验：删干净了没有
ls -l /opt/probe/app/.data /opt/probe/app/.cache /root/backups 2>&1
```

停站但**保留**数据（备案整改、临时下线）别走这条路：那是 `systemctl stop probe-web` 就够，
数据原地不动，起回来还是原来那份。

> 口诀：**停机不等于删除。** 只有确定不再提供服务时才执行上面的 rm，而且第 3 步必须做 ——
> 备份是唯一一份「删了还能活过来」的副本，它留着，删除就没有发生。

## 十一、关注实体（watches / watch_hits）

设计稿在 `docs/DESIGN-b2.md` §9 与 §17-P1，这里只写值班要用的。

### 它是什么

同库（`probe.db`）里多两张表，前提是历史开着（`PROBE_HISTORY_SERVER=1`）：

| 表 | 存什么 |
| --- | --- |
| `watches` | 一行一个关注：主体、归一后的 key、别名、类别（org/tech/person/geo/event/other） |
| `watch_hits` | 命中：被命中的标题、链接、来源站点、热度、何时记下、`read_at` |

**不存正文、不存关注理由、不发邮件不发短信。** 命中来自热榜那一轮统计（`/api/cron/heat`），
所以热榜定时任务停了，关注也就不会再有新条目 —— 它没有自己的 timer。

**`provider` 存的是上游 id**（`hn` / `ithome` / `sspai` / `baidu` / `juejin`），不是中文名。
改展示文案只动 `src/lib/provider-label.ts`，不要回头改历史数据；没有映射的 id 原样显示 ——
显示一个陌生 id 好过把不认识的源硬翻成某个中文名。

### 开关（probe.env）

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PROBE_WATCH_SERVER` | `1` | 关掉：读接口回 `enabled:false`、写接口回 404 `watch_disabled`、/account 面板消失 |
| `PROBE_WATCH_PER_USER` | `50` | 每人最多关注几个（上限 500） |
| `PROBE_WATCH_HITS_PER_WATCH` | `50` | 每个关注最多留几条，超了删最旧 |
| `PROBE_WATCH_HIT_DAYS` | `30` | 命中保留天数（上限 365） |

`PROBE_HISTORY_SERVER=0` 会连关注一起关（历史是它的地基）。

### 值班常看的几件事

```bash
# 有多少人在关注、命中积了多少
sqlite3 /opt/probe/app/.data/probe.db 'select count(*) watches from watches; select count(*) hits, sum(read_at is null) unread from watch_hits;'

# 谁关注了什么（只在排查「为什么他有这条」时看）
sqlite3 /opt/probe/app/.data/probe.db 'select user_id, name, kind from watches order by created_at desc limit 20;'

# 热榜那一轮的关注结果（响应体里的 watch 字段）
curl -s -H "x-probe-cron-secret: $PROBE_CRON_SECRET" http://127.0.0.1:3215/api/cron/heat | tr , '\n' | grep -A3 watch
```

### 出问题怎么退

- **命中不进来**：先看热榜那一轮有没有跑（`systemctl list-timers probe-heat.timer`），再看日志 `journalctl -u probe-web | grep \[watch\]`。
  落库失败只 `console.warn`，不影响热榜本身，也不影响别人的页面。
- **条目太多/太吵**：调小 `PROBE_WATCH_HITS_PER_WATCH` 与 `PROBE_WATCH_HIT_DAYS` 重启，下一轮 cron 会顺手删旧（`pruneHits`）。
- **某人不想被记**：他自己在 /account 点删除即可；要手工清：`delete from watch_hits where user_id='...'; delete from watches where user_id='...';`（命中随关注级联删）。

### 还没做

- 关注命中的推送（邮件/IM）：刻意没做，站内提示是这一版的天花板。
- 用模型复核歧义：`watch-match.ts` 现在靠歧义词表 + 上下文正则，宁可漏也不误报。

## 十二、国内热议榜单（百度热搜 / 掘金）

设计稿在 `docs/DESIGN-b2.md` §17 的「C 期 · B 阶段」。这一节只写值班要用的。

### 它是什么

首屏「国内热议」那一块：百度热搜 + 掘金热榜，**原样展示**，不参与热度公式，也不建基线。
同一次抓取的结果会喂给关注实体（`hotStories` → `recordHits`），所以榜单轨和关注是同一个进程内存里的同一份数据。

**只落索引**：进库的只有标题、链接、来源、热度、抓取时间（和热榜同一条路径）。正文不进库，页面上的每个条目都标了来源。

### 开关（probe.env）

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PROBE_HOTLIST_SERVER` | `1` | `0` = 整块不抓、页面不显示、cron 记 `hotlist:disabled` |
| `PROBE_HOTLIST_SOURCES` | `baidu,juejin` | 逗号分隔。微博(403)/知乎(401) 公开接口已关，别加进来 |

缓存是写死的 15 分钟（`CACHE_TTL_MS`），不设环境变量 —— 它同时是限速闸门，调小就是对上游加压。

### 值班常看的几件事

```bash
# 榜单这一轮抓到了什么（响应体里的 hot 字段）
curl -s -H "x-probe-cron-secret: $PROBE_CRON_SECRET" http://127.0.0.1:3215/api/cron/heat | tr , '\n' | grep -A6 '"hot"'

# 页面那侧：直接看首屏有没有「国内热议」
curl -s http://127.0.0.1:3215/ | grep -c '国内热议'
```

`hot.degraded` 里的机器名对着看：

| 值 | 人话 | 处理 |
| --- | --- | --- |
| `baidu:failed` / `juejin:failed` | 两次都没连上（含非 2xx、超时 6s） | 先 `curl -m 8` 手打那个接口；403/401 = 上游关了口子，把源从 `PROBE_HOTLIST_SOURCES` 摘掉 |
| `baidu:empty` / `juejin:empty` | 连上了但解析出 0 条 | 上游结构变了 → 看 `parse*` 的字段假设，改解析而不是加源 |
| `hotlist:empty` | 所有源都空 | 通常是这台机器的出网挂了，查 `curl -I https://top.baidu.com` |
| `hotlist:disabled` | 开关关了 | 正常，不是故障 |

### 页面上那两个时间不是一回事

卡片头部会写「榜单更新于 X · 抓取于 Y」：

- **抓取于** = 我们这台机器上 `fetch` 回来的时刻（`list.fetchedAt`，缓存 5 分钟）。
- **榜单更新于** = 百度自己给的 `data.cards[*].updateTime`（秒级 unix 时间戳 → `parseBaiduUpdatedAt`）。

为什么要分开：榜单可能十分钟没动过，我们却每分钟都在抓。只写「更新于抓取时间」等于把「我刚抓的」
冒充成「榜单刚更新的」——这是最容易被截图抓住的那种假。某个源没给这个字段（掘金就没有），
那就只显示「抓取于」，**不编一个时间出来**。

### 出问题怎么退

- **整块消失**：先看开关，再看 `hot.degraded`。页面是「拿不到就不渲染这一块」，所以消失 ≠ 500。
- **首屏变慢**：抓取超时是 6s、两块并行取。如果首屏稳定卡 6 秒，说明出网在丢包（不是代码问题），
  临时 `PROBE_HOTLIST_SERVER=0` 重启即可，热榜轨不受影响。
- **上游改结构**：解析是「看到 `query|word|title` + `http(s)` 链接就认」，字段改名大概率还能活；
  整体换 JSON 形状就只会返回空（记 `empty`），不会抛错、不会把首屏搞白。

### 还没做

- ~~A 阶段：IT之家 / 少数派 接进热度公式~~ —— 已实施，见下一节「十三、中文科技前沿」。
- 微博 / 知乎：公开接口 403 / 401，没有官方 key 就不接，页面上直接写清楚「未接入」，不假装有。

## 十三、中文科技前沿（IT之家 / 少数派）

设计稿在 `docs/DESIGN-b2.md` §17 的「A 阶段」。这一节只写值班要用的。

### 它是什么

首屏「中文科技前沿」那一块：IT之家（接口 25 条 + RSS 60 条）+ 少数派（翻页取最近 50 条），
按实体聚合后**进热度公式**——名次、状态标签、r7 都算，和 Hacker News 那条是同一套公式。

**为什么它不能和 HN 共用基线**：HN 一天上千条 story，这两个中文源一天不到 150 条。
同一条中线放在两条分布上，「多少条在写它」的含义完全不同，混进一份基线 r7 会来回抽动。
所以它有自己的一份：`.cache/cn-history.json`（和 `hn-history.json`、`feedback.jsonl` 同一个目录）。

**只落索引**：进库的只有标题、链接、来源、抓取时间（走 `recordHits`，和热榜同一条路径）。正文不进库。

### 开关（probe.env）

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PROBE_CN_TRENDING_SERVER` | `1` | `0` = 整块不抓、页面不显示、cron 不记基线 |
| `PROBE_CN_TRENDING_SOURCES` | `ithome,sspai` | 逗号分隔。两个都是公开接口，不要 key |

缓存写死 10 分钟（`CACHE_TTL_MS`），基线没攒够时改成 60 秒（`CACHE_TTL_PENDING_MS`）——
让它在第一天就能被 cron 反复读到、快点把基线攒起来。上游地址在代码里写死 https，
不从环境变量拼（那会变成半个 SSRF 入口）。

### 基线是怎么攒的（这条最容易踩）

这两个源只给「最近 N 条」，**没有按时间检索的接口**，往回补历史是不可能的。
所以只能**从挂上那天开始攒**：cron 每轮顺手记一次当天的日计数，跨 UTC 日界开新的一天。

- 攒够 `CN_BOOTSTRAP_DAYS = 14` 天才第一次出状态标签（跟着 `heat.seriesStats()` 的门槛走：
  序列少于 14 天它直接返回 null）。在这之前页面写「基线攒到 N/14 天，只排名次、不给状态标签」。
- 去重靠「当日唯一 URL 集合」（`known.has(url)`）。cron 每 30 分钟一轮，没有它，
  同一篇文章会被数 20 遍，日计数变成「轮次 × 条数」，全是假的。
- 日计数留 45 天（够算 median_30d），seen 只留两天（今天去重 + 跨零点那一轮的昨天）。

### 值班常看的几件事

```bash
# 中文源这一轮抓到了什么（响应体里的 cn 字段）
curl -s -H "x-probe-cron-secret: $PROBE_CRON_SECRET" http://127.0.0.1:3215/api/cron/heat \
  | tr , '\n' | grep -A12 '"cn"'

# 基线攒到第几天了
cat /opt/probe/app/.cache/cn-history.json | head -c 300

# 页面那侧：直接看首屏有没有「中文科技前沿」
curl -s http://127.0.0.1:3215/ | grep -c '中文科技前沿'
```

`cn.degraded` 里的机器名对着看：

| 值 | 人话 | 处理 |
| --- | --- | --- |
| `ithome:list_failed` | 接口那条没连上（重试一次后仍失败） | RSS 那条可能还活着，先看页面条数是不是只剩 RSS 的量 |
| `ithome:rss_failed` | RSS 没连上 | 接口那条够不够覆盖 24h 在页面上照实写了，不影响出数 |
| `sspai:failed` | 首次请求失败（重试一次后仍失败） | 先 `curl -m 8` 手打那个接口；403/401 = 上游关了口子 |
| `cn:empty` | 所有源加起来 0 条 | 通常是这台机器的出网挂了，查 `curl -I https://api.ithome.com` |
| `cn:baseline_empty` | 基线文件还没建（第一天） | 正常。等 cron 跑过一轮就有了 |
| `cn:baseline_partial` | 基线有但不满 14 天 | 正常。页面只排名次、不给状态标签 |

### 出问题怎么退

- **整块消失**：先看开关，再看 `cn.degraded`。页面是「拿不到就不渲染这一块」，所以消失 ≠ 500。
- **状态标签全是「持平」**：先看基线攒够没有（`pending`）。第 14 天之前本来就不出标签。
  攒够了还全是持平，就是真的没波动 —— 中文源一天不到 150 条，比 HN 安静得多，这是正常的。
- **首屏变慢**：抓取超时 8s，两个源并行。稳定卡 8 秒说明出网在丢包（不是代码问题），
  临时 `PROBE_CN_TRENDING_SERVER=0` 重启即可，HN 与国内热议都不受影响。
- **基线文件坏了**：直接删掉 `.cache/cn-history.json`。它是纯派生数据，
  丢了顶多「14 天倒计时重来」，不影响历史、关注、榜单任何一块。

### 已知取舍（不是忘）

- 覆盖不满 24 小时：IT之家接口 25 条≈10h、RSS 60 条≈13h，合并去重后仍不满 24h。
  `coveredHours` **照实报**，页面写「覆盖约 N 小时」，不假装是全天。
- 少数派 `content_api` 那个接口不给发布时间（`ctime` 恒为 0），所以只用了 `article/index/page/get`。
- 「加密 / 隐私 / 安全」这类词刻意没收进中文实体表：在中文新闻里它们是口头禅，
  收进来会让每个话题都被命中一次，名次变成噪声。
- 微博 / 知乎：公开接口 403 / 401，没有官方 key 就不接。

