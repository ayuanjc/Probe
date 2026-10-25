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

| 闸 | 环境变量 | 默认 | 单位 |
| --- | --- | --- | --- |
| 全局 | `PROBE_DAILY_LLM_CALLS` | 2000 | 整个进程 / 天 |
| 按人 | `PROBE_DAILY_LLM_CALLS_PER_USER` | 120 | 每个账号 / 天（未登录按 IP） |

关键在**顺序**：先判全局，再判个人；**个人被拦时不消耗全局额度**（否则一个人狂点
会让全站提前降级）。两者都通过才各 +1。

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

同一页签的「设置」是部署态只读视图（模型端点、区域判定、检索源配没配、备案号、鉴权模式）。
故意只读：能从浏览器改这些，等于拿到 admin 就能关掉鉴权、换掉模型端点。
要改就编辑 `/opt/probe/probe.env` 再 `systemctl restart probe-web`。
---

## 五、CI（P0 第 7 项）

`.github/workflows/ci.yml` 两个 job：

1. `test`：`npm ci` → `npm run typecheck` → `npm test`（318 条）
2. `build`：`npm ci` → `npm run build` → **smoke**

smoke 为什么必须有：构建能过 ≠ 能启动。缺一个运行时 env、Server Component 里抛错，
都只会在 `next start` 之后才炸。它真起一次服务，然后：

- `/login` `/privacy` `/terms` `/api/version` 必须 200
- `/api/admin/users` 未登录必须 **401**（权限闸真的在跑，不是 200）
- 隐私页 HTML 里必须能找到 `粤ICP备…`（页脚备案号是备案验收项，缺了会被驳回）

注入的测试备案号是假的（`粤ICP备00000000号-1`），只用来断言「渲染链路通」。

---

## 六、现在还没做的

| 项 | 卡在哪 | 下一步 |
| --- | --- | --- |
| HTTPS（第 2 项） | 备案期域名被云侧阻断：任何公网 HTTP 请求都被 302 到 `dnspod.qcloud.com/static/webblock.html`，Let's Encrypt 的 HTTP-01 校验够不到 nginx | 要么在腾讯云控制台签免费 DV 证书（DNS 校验，域名已在 DNSPod，界面点几下）再拿 nginx 格式的证书给我装；要么给一把 DNSPod API token，我用 acme.sh 的 DNS-01 全自动签发 + 自动续期 |
| 境内检索源（第 1 项，本轮跳过） | 博查 key 欠费 403 `You do not have enough money or package quota` | 充值，或接第二家境内搜索 API |
| 备份异地 | 需要 COS 密钥 | 上对象存储后把 tar 包同步过去 |
| 外部拨测 | 控制台操作 | 腾讯云云监控站点拨测 / UptimeRobot，每分钟敲一次 `/api/version` |
