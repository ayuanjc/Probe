# 全量代码审查与加固记录

> 起因：备案完成后要对外提供服务，先做一次不设范围的通读 + 畸形输入测试，把「会算错数 / 会崩 / 会卡死 / 会泄露」的地方一次性清掉。
> 本文件只记**已经改完的事实**与**仍不打算改的理由**。没验证过的猜测不进这里。

## 一、方法

1. **六个分片通读**（只读评审，不允许改代码）：agents+llm 上游边界、`src/app/api/**`、`src/components/**`+`src/hooks/**`、`src/lib/**`（非 auth）、`auth/store+account`、`auth/session+crypto+guard+api/auth+api/admin`。
   前两项与客户端那份给出了完整清单；auth 的两片连续跑到上下文耗尽没交报告，改成自己逐行读（`store.ts` / `crypto.ts` / `session.ts` / `guard.ts` / `account.ts` / 四个 auth 路由）。
2. **畸形输入测试** `scripts/probe-fuzz.mjs`：16 个 POST × 12 种体（空体、非 JSON、`null`、`[]`、`42`、`{}`、2000 层嵌套、200KB、错类型、NaN、`__proto__`、控制字符）+ 16 个 GET × 12 种 query（`%00`、SQL 串、路径穿越、`limit=-1`/`1e9`/超长、重复参数、`__proto__[polluted]`）+ 方法错配。判据只有一条：**客户端错误必须回结构化 JSON，不能 500 裸栈**。
   `npm run fuzz`（`BASE=` 指服务地址，`STRICT=1` 连「4xx 非 JSON」也算失败）。
3. **关键路径自己重读**：流水线与核验链、`dossier` 坐标、`llm` 调用边界、`region`/`region-policy`、限流与闸门、`http.ts` 抓取层。

## 二、最严重的两条（会静默算错，界面看不出来）

### 1. 核验结论贴错了断言（`src/agents/verify-pipeline.ts`）

`selectVerifiable()` 给出的 `index` 是**全量 claims 下标**，`kept` 又按分数降序排过；而 `buildDossier()` 回填用的是**传入数组位置**。核验只会跑分数最高的前 N 条，于是 `verdicts` 里的 `claimIndex` 被当成位置下标用 → 一条断言的吻合度、字母档、证据行全贴到另一条断言上。前端 `claimsByIdx.get(row.claimIndex)` 要的是全量坐标，所以界面完全自洽，看不出错。

修法：交给 `buildDossier()` 之前用 `posOf` 把 `claimIndex` 重映射成位置下标，取回 `rows` 后再映射回全量坐标再算分；SSE 事件（`evidence.retrieved` / `nli.verdict`）里的 `claimIndex` 保持全量坐标不动 —— 它要和 `claim.extracted` 的 `start+i` 对齐。

### 2. 留出集证据 id 撞号（`src/agents/heldout.ts`）

`id: "held-" + i` 的 `i` 是**每次检索内部**的行号，每条断言都从 `held-0` 开始。消费方 `authById.set(e.id, …)` 互相覆盖、`seenEvidence` 按 id 去重 → 有效独立源数系统性少算，`hasHighAuthorityConflict` 的 owner 聚合失真。

修法：`makeHeldoutRetriever(claim, claimIndex)` 把行重编号成 `held-<claimIndex>-<i>`。`tests/heldout.test.ts` 补了「不同断言的证据 id 不撞号」用例。

## 三、上游调用与额度

- `src/lib/llm.ts`：`generateText` / `generateObject` 原来既无 `abortSignal` 也无超时 → 上游挂起则整条流水线无限期挂住、客户端断开也不停、额度已扣。现统一走 `callSignal()`（`PROBE_LLM_TIMEOUT_MS`，默认 30s，上限 300s；与调用方 `signal` 用 `AbortSignal.any` 合并），并从 `runPipeline` / `runVerify` 一路透传到检索与判定。
- 同一处 `maxRetries: 0`：外层自己 `for attempt < 2` 重试，而 ai@7 默认还会再试 2 次 → 单次逻辑调用最多 6 发上游，而 `takeBudget()` 只记 1 次。现在重试前也 `takeBudget()`。
- `textOnlyUpstreams` 缓存键从「base URL」改成「base URL + key 短哈希」：原来任何用户自带 key 的网关拒一次 `json_schema`，该地址下所有用户（含官方 key）会永久退化到纯文本 JSON 直到重启。
- `src/agents/verify-pipeline.ts`：`signal` 原来只在步骤之间检查 → 关掉页面后仍烧 30+ 次上游调用数分钟。现已透传到抽取与判定，并在 `verifyOne` 前后判 `aborted`；中断与「文章没有可核断言」也不再共用 `no_claims`，新增 `blocked: "aborted"`（前端有对应文案：「核验已取消 —— 这不是这篇文章的问题」）。
- `src/lib/metrics.ts` 新增 `usageAccumulator()`：核验链路原来完全没有 `UsageSink`，跑几十次上游在 `metrics` 里显示 0 token。它刻意不进 `runs` 环（核验没有 query/stages/confidence，混进去会污染分布），收尾打 `console.info("[verify] usage", …)`。
- `src/lib/llm.ts` 流式中断且已经吐过字时补 `truncationNote()`（「摘要到这里中断了……」）—— 原来用户会读到半句话，`done` 里也没有对应降级码。

## 四、上游返回形态

- 博查：`200 + {code,msg}` 的错误信封与「没命中」同形（都取 `pages ?? []`）→ 欠费会被记成 `bocha:empty`，把配置问题伪装成事实缺失。现在没有 `webPages` 且带 `code/msg/message` 就抛。
- 留出集检索 `heldout.ts`：`await res.json()` 原来没有 try、也没有 content-type 判定 → WAF 挑战页（200 + HTML）会抛 SyntaxError，被记成 `verify:find_failed_N`，把「响应不是 JSON」误报成「检索挂了」。
- Wiki 解析原来假设 `items[0]` 存在、`views` 是数字、`timestamp` 是 10 位 → 标题渲成 `undefined`，或 `new Date(Date.UTC(NaN)).toISOString()` 抛 RangeError。改成逐字段类型守卫。
- `src/lib/http.ts` 的 charset 正则少了一个反斜杠（`[w-]+`），声明 gbk/gb2312/big5 的页面整体匹配失败 → 中文整篇乱码；`windows-1252` 只捕获到 `"w"` 再进 `TextDecoder` 抛错、被 catch 兜回 utf-8。另修：`hostCache` 在 5 分钟内 512+ 域名时一条都删不掉（Map 无界）；重定向每跳重开 8s 计时器（3 跳 ~32s），改成传绝对 deadline。

## 五、数字与文案

- `src/lib/agreement.ts`：`colSum` 用**判定者数**当列数、却按类别数写 → 类别数 > 判定者数时 `colSum[j]` 为 `undefined` → NaN；而 NaN 过不了 `Math.abs(1 - pExpected) < 1e-12` 的守卫，`fleissKappa` 会返回 `{kappa: NaN}` 而不是 `null`。
- `src/lib/confidence.ts` 导出 `NO_CHECK_CONSISTENCY_CAP`、`src/lib/heat.ts` 导出 `RATIO_CAP`，术语表和 `ConfidenceBadge` 的文案改为引用常量：原来文案写「上限 0.74 / 分母为 0 按 99 记」，代码是 0.64 / 9.99 —— 两处对不上，用户按术语表算出来的数永远不等于界面。
- `src/lib/entities.ts`：词典第 1 步只遍历 `zh`，不查建好的 `EN_ALIAS` → 智谱 / 美联储 / 量子计算 / 人形机器人遇英文查询完全不命中，落到「首词当 org」兜底；另两条 `en: "large language model"` 后者覆盖前者（丢「大模型」语义）。
- `src/lib/key-figures.ts`：`unit` 为空但数值带 `%` 时补出 `unit="%"`，可查重与入库仍用原 `claim.unit` → 同一个数在表里出现两行（一行没有单位）；`findSame` 的键只有 `normalized+unit` 不含 `period` → 「2024 年 12%」与「2025 年 12%」并成一行、`period/quote` 取第一期，行里引用两条信源但其中一条原文没有这个口径。
- `src/lib/heat-history.ts`：`isHistory` 不校验每天的形状、也不校验 `to` 可解析 → (a) 某天缺 `counts` 时 `d.counts[topic]` 抛 TypeError 被上层吞掉，首页永远 pending；(b) `to="2026-13-45"` 让窗口计算得 NaN，写回空窗口后进入「永远 stale、永远重建」的静默循环。`trending.ts` 的 `new Date(hit.created_at_i * 1000)` 同理（缺字段即 RangeError，且解析在 try 之外，整份基线失败）。

## 六、部署与配置

- `src/lib/runtime-config.ts`：元数据地址只做字符串精确比对 → `http://metadata.google.internal./`（尾点）、`http://[::ffff:169.254.169.254]/`、`http://[fe80::1]/v1` 都能绕过去，把服务端变成「带凭证访问云元数据」的跳板。现在去方括号、去尾点，并把 IPv4-mapped 的两种写法（`::ffff:169.254.169.254` 与 URL 规范化后的 `::ffff:a9fe:a9fe`）都还原成点分再判 169.254/fe80。
- 同一处 `t.length < 12` 的下限把 `http://x.io`、`http://llm` 这类合法内网地址静默当成没填 → 回落 `OPENAI_BASE_URL`（也就是悄悄出境）。下限删掉，只留 300 上限。
- `src/lib/region-policy.ts` 的私网判定补 `host.docker.internal`、`169.254.*`、`[::ffff:169.254.*]`：境内 + 自建模型 `http://host.docker.internal:11434/v1` 原来被判 `blocked`。
- `src/lib/legal/contact.ts`：`env` 设成 `"   "` 时得空串，界面印「运营者邮箱（部署方未配置）」。
- `src/lib/base-path.ts`：`NEXT_PUBLIC_PROBE_BASE_PATH=probe`（缺前导斜杠）会拼出 `probe/api/search` 这种相对路径，二级路由下打到错的层级。
- `docs` 与 `.env.example`：补上代码真读但模板漏写的 `PROBE_SITE_URL`、`NEXT_PUBLIC_PROBE_VERSION`、`PROBE_CRON_SECRET`、`PROBE_METRICS_KEY`、`PROBE_INVITE_CHECK_RATE_PER_MIN`、`PROBE_REGION_RATE_PER_MIN`；Supabase 段标注「目前没有任何代码读取」（`grep -rn supabase src` 无命中）；`PROBE_DAILY_TOKEN_BUDGET` 注明无代码读取，真正生效的是 `PROBE_DAILY_LLM_CALLS`。

## 七、接口权限与滥用

- `src/app/api/evidence/route.ts`：整个 POST 从未 `prepareRuntimeConfig` / `withRuntimeConfig` → 设置面板填的 key（走请求头→ALS）看不到，永远返回「本机缺留出集检索」；env 有 key 时又绕过区域闸门。已与 `search` / `verify` 对齐。
- `src/app/api/translate/route.ts`：唯一没有 `requireUser` 的内容接口 —— 匿名即可烧服务端 key，并让服务端代抓任意外链正文。现已登录才可用。
- `src/app/api/calibration/route.ts`：`labelSample` 不校验样本归属，而 `GET` 的 `snapshot.recent` 会带最近 10 条样本 id → 任意登录用户按 id POST `{id,correct}` 就能改写全局 ECE/MCE/Brier。
- 四条 `admin` GET 补 `isCrossSite()`（响应里全是账号名 / 邀请码 / 地址指纹）；`/api/auth/sessions` 的 GET 补 per-client 限流；`/api/auth/signup` 的邀请码边输边验补跨站判定与限流（原来是无鉴权无限流的 oracle，会泄露「码是否存在 + role + remainingUses」）；`/api/region` 补限流（返回值含 `modelHost`，等于部署指纹）。
- `src/app/api/auth/login/route.ts` 新增**按账号**的失败退避（15 分钟窗口内错 3 次后逐次 +200ms，封顶 1.5s）：per-IP 5/min 挡不住「同一账号 + 大量 IP」的撞库。用延迟而不是 429，是为了不让人拿别人的用户名把人锁死。
- `src/app/api/consent/route.ts`：cookie 时间戳改用服务端 `Date.now()` —— 采信客户端 `at` 会让「本服务发出去、又被自己判成伪造」的自我矛盾成立。`/api/feedback/route.ts` 的 `ip` 改存地址指纹（与审计日志同口径），并把「stat 看大小 + append」压进临界区（8MB 上限原来只对串行成立）。
- 邀请码数值校验：`store.createInvite` 与 `api/admin/invites` 都直接 `Math.min/max/floor` —— `NaN` 一路穿透，`uses >= maxUses` 永不成立（**无限次邀请码**），`expiresAt=NaN` 经 JSON 序列化变 `null`（**永不过期**）。现在先 `Number.isFinite` 再夹紧，管理员显式传 `null` 仍表示「不过期」。
- `src/lib/auth/guard.ts`：`PROBE_AUTH_MODE=off` 时每请求都是 admin（后台全敞开）。行为不改（尊重运维显式配置），但生产环境启动时打一条警告。

## 八、客户端

- `SettingsPanel` 焦点陷阱：父组件传的是内联 `onClose`，每敲一个字符就重渲染 → effect 依赖 `[open, onClose]` 整段重跑、cleanup 把焦点还给原元素、新 rAF 又拽回抽屉 → 面板实际不可用。改 `onCloseRef` + 依赖 `[open]`；初始焦点也不再落到「关闭设置」按钮上。
- `admin/shared.tsx` 的 `api()` 裸 `fetch`：断网 / 502 时 reject，而 9 处调用方都没有 catch → `setBusy("")` 永不执行、按钮永久禁用。现在网络层失败回 `{ok:false, status:0, message:"网络异常…"}`。
- `useProbe`：SSE 被截断（没收到 `done`）原来无条件判 `status:"done"` → 用户看到半截结果以为是完整结论。现在只有真收到 `done` 才算完成，否则 `failed` + 「连接中断，本轮结果不完整」。
- `ConsentGate`：原来非 2xx 一律 throw 进同一个 catch，而 catch 会写本地 cookie 并 `setAccepted(true)` → 400/403/429/500 全都放行，服务端没有同意记录。现在只有「网络层失败」才写 fallback cookie，其余把状态码显示出来。
- `InvitesTab`：`Number(uses) || 1` 让 `abc` 静默变 1 次；`Number(hours) > 0` 放行 `Infinity`，而 `JSON.stringify(Infinity) === "null"` → 邀请码从 72 小时变成永不过期。`UsersTab` 的重置密码原来服务端失败也清空刚输入的密码。
- 时序类：`AuthPanels` 邀请码边输边验加 `AbortController` + 代号比对（旧码响应会显示在新码位置）；`FeedbackButton` 加 in-flight 序号（旧请求晚到会清空新草稿并误报「已收到」）；`MetricsPanel` 5s 轮询加序号（响应慢于 5s 时数字往回跳）；`ModulePrompt` 加 `alive` 守卫（点「生成」后浮层立刻卸载，回调仍会插卡）；`UpdateBanner` 失败退避 10s→20s→40s→60s（原来离线状态下永远 10 秒一拍）；`AdminConsole` / `ConfigDocs` / `Workspace` 的 `setTimeout` 都存 timer 并在卸载时清。
- `EntityGraphCard`：ECharts 按 `name` 归并节点，而 links 的 `source/target` 用的是去重后的标签名（`X`、`X·2`）→ 同名实体与「本身叫 X·2 的实体」会被合并、边连错。改用节点 id。
- `BilingualCompare`：模块级缓存的 key 只有 `url + title`，但请求体还带 `text` → 同 URL 同标题的不同片段命中旧译文。
- `Workspace` 的降级码翻译漏了 `dated` / `dataset` / `rows` 三个前缀，界面上会把内部标识（`dated（from_url_3）`）直接印出来；`claims:extract_failed` 也只剩一个「事实断言抽取」不带原因，与「跑起来但没抽到」混成一句。
- 首页 `?q=` 与侧栏「最近」都不夹长度：前者会拿一个几十 KB 的查询去自动发起一轮注定被 400 的请求，后者能让一条手改过的超长记录撑满侧边栏。两处都夹到 400 字（与 `/api/search` 的上限一致）。

## 九、验证

| 项目 | 结果 |
| --- | --- |
| `npx tsc --noEmit` | 0 error |
| `npm test` | **313 / 313 通过**（审查前基线 301，新增 12 条针对上述缺陷的回归用例） |
| `npx next build` | 通过 |
| `npm run fuzz`（STRICT） | 389 用例：**0 个真 500、0 个结构化违约**。报出的 38 条全是已知两类：28 条是 Next 对未实现方法返回的空体 405（框架行为，不是 handler），10 条是 `POST /api/cron/heat` 未配 `PROBE_CRON_SECRET` 时的预期 503。 |
| 定向 curl | 跨站 `Origin` 打 `/api/auth/signup` 与 `/api/admin/users` → 403 `cross_site`；无 Origin 打 `/api/admin/users` → 401；`/api/region` → 200 |

## 十、明确不改的地方（附理由）

- `src/hooks/useProbe.ts` 卸载后 `setTimeout(..., 0)` 再决定是否 abort：StrictMode 双挂载会把 `?q=` 自启那一轮杀掉，而 `booted` 已为 true → 永不重发。刻意写法。
- `src/app/api/auth/me` 不返回 401（用 `{auth:false}`）：未登录要读它，401 会让前端把「没登录」当异常。
- `src/app/ayuanjc/page.tsx` 用非 `/admin` 路径：只是一层扫描噪声，真正的边界是 `requirePageAdmin()` 与 `/api/admin/*` 的 `requireAdmin()`。
- 日文协议正文不参与 `termsFingerprint()`：`TERMS_JA` 没有任何路由引用，把用户看不见的正文算进版本号等于强制所有人重新点一次同意。

## 十一、仍然存在、但属于设计取舍的风险

1. **检索源出境**：境内访客已被区域策略限制为境内检索 + 境内模型（`region-policy.ts`），但留出集核验走的 Tavily 仍是美国服务 —— 这条链路的输入是公开文档片段，不是用户数据，仍然构成数据出境。彻底解决要换境内搜索 API，属功能改动。
2. **`/api/translate` 仍是「替我抓网页」**：`http.ts` 挡住了内网与元数据地址，任何登录用户仍可让服务端去抓任意公网 URL。限流是唯一的滥用刹车。
3. **限流是进程内的**：多实例部署时每实例各自计数。单机（当前 2C4G）没问题，扩容前要换成共享计数。
4. **`POST /api/feedback` 的 8MB 上限靠单进程写锁**：多实例下并发 append 仍可能越限。
