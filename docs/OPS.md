# 运维（OPS）：备份、存活探针、首屏体积、按人额度、CI

这份文档对应差距清单里的 P0 第 2–7 项。每一项都写清「它解决哪种具体的坏结果」，
因为这几件事的共同点是：**不做也不影响今天能打开网站**，只在出事那天才发现没做。

---

## 一、每日备份

### 为什么必须有

探针没有数据库。全部账号、会话、审计、协议同意记录都在这几个文件里：

| 文件 | 丢了会怎样 |
| --- | --- |
| `/opt/probe/app/.data/auth/store.json` | 所有人被登出、管理员被重种（bootstrap 会用 env 里那组账号密码重建）、审计与封禁一起消失 |
| `/opt/probe/app/.data/consent/consent.log` | 协议同意留痕没了 —— 这是备案/隐私查验时要给的东西 |
| `/opt/probe/app/.cache/feedback.jsonl` | 用户反馈没了 |
| `/opt/probe/app/.cache/hn-history.json` | 热榜基线没了（只是首屏变慢，会自动重建） |
| `/opt/probe/probe.env` | 运行配置与所有 key（恢复时没有它，光有数据也起不来） |
| `/opt/probe/deployed-sha` | 不知道这份备份对应哪个提交 |

这些文件都不是数据库，没有任何自带副本。手工 `cp` 靠人记得，靠不住。

### 它做了什么

脚本：`scripts/server/backup-probe.sh`（服务器上是 `/opt/probe/bin/backup-probe.sh`）

- 打包到 `/root/backups/probe/probe-YYYYmmdd-HHMMSS.tar.gz`，目录 `0700`、包 `0600`
- 只留最近 **14** 份（按修改时间，不按文件名 —— 跨年时按名字排序会留错）
- **三道校验**：`store.json` 必须在（少了就直接失败，绝不生成一个看起来成功的空备份）；
  `tar -tzf` 必须能读（截断的包只在解包时才报错，那时已经晚了）；`store.json` 必须是合法 JSON
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

## 九、容量实测（2 核 4G / 5Mbps 那台）

`scripts/loadtest.mjs` 只打**不花钱**的端点。为什么不压 `/api/search`：一次提问 = 2–3 次上游 LLM 调用
+ 一次检索，压出来的是「上游多久回」，不是「这台机器能扛多少」。钱和延迟都不在这台机器手上。

```bash
# 在服务器本机（绕过 nginx 与云侧阻断，测的是 Node 本身）
BASE=http://127.0.0.1:3215 CONCURRENCY=20 DURATION_MS=12000 /opt/node/bin/node /tmp/loadtest.mjs
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
