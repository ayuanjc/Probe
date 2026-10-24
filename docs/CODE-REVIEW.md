# 代码审查（src/ 全量，7213 行 / 42 文件）

时间：2026-10-23。方法：5 个只读审查员分片（lib 数值、lib IO、agents、前端组件、翻译/设置/layout/compile/trending）+ 主 agent 逐个文件复核 + 2 条运行时复算与 1 条浏览器实测。审查当时未改动任何源码；后续修复在条目里以「→ **已修**」标注。

分级：**P0** 会崩 / 数据错误 / 安全；**P1** 行为与注释或契约不符、用户可感知的功能缺陷；**P2** 健壮性、可维护性、性能。

结论：架构与「不编造」的原则在流水线层守得住（缺数据不出图、fixture 封顶、置信度软约束都在），漏洞集中在**边界层**——外部抓取（SSRF / 超时 / 编码）、翻译打分的启发式、低置信抑制只做了一半、以及若干界面文案与实现不符。

---

## P0

1. `src/lib/http.ts:55-59` + `src/lib/translate.ts:96-108` — **重定向不复检主机，SSRF 可打内网与云元数据**。blockedHost 只校验用户提交的初始 hostname，getDirect 每跳递归不再过白名单：`http://X/` 302 到 `http://169.254.169.254/latest/meta-data/`、`http://localhost.:3000`、`http://[::ffff:127.0.0.1]/`、`http://127.0.0.1.nip.io/` 全部放行，而 url 来自无鉴权的 `POST /api/translate` 的 body.url。→ **已修**：`hostAllowed()` 下沉进 `getDirect` 入口（每跳递归都过一遍），`dns.lookup(host,{all:true})` 后按真实 IP 判私网，任一解析地址是私网即拒；`isPrivateAddress()` 覆盖 IPv4 前缀表 + IPv6 特殊段 + IPv4-mapped 两种写法。`translate.ts` 的本地 `blockedHost` 已删。
2. `src/lib/http.ts:57` — `new URL(location, parsed)` 在 res 回调里没有 try：Location 为 `//` 或 IPv6 括号损坏时抛同步异常 → 未捕获错误（路由 500 / 进程崩），Promise 也不 settle。→ **已修**：`new URL` 包 try/catch 返回 `invalid_redirect`，并校验下一跳只允许 http(s)。
3. `src/lib/llm.ts:92` — 流中断后 catch 里 `yield fixtureSummary()`，而那段文本写死「当前没有可用的模型 key」；此时 pipeline 的 wrote 已被前面的 delta 置真，用户拿到半截真摘要 + 一句关于配置的假话。→ **已修**：`fixtureSummary()` 只留给无 key 分支；新增 `failureNote()` 只陈述事实。改用 `fullStream` 才看得见失败 —— `textStream` 会把 provider 错误吞成空流，所以原来 catch 根本没触发过。
4. `src/lib/translate-risk.ts:121-146` — **整段一字未译也会拿到 risk 0 / low**（运行时复算：`translationRisk("NVIDIA Announces New GPU For Data Centers", 原文, "en")` → `{risk:0, band:"low", signals:[]}`）。srcCaps 把首字母大写词全量排除，标题式大写句剔完只剩全大写词，`if (words.length < 2 && longest < 8)` 直接跳过。→ **已修**：`looksUntranslated()` 前置判定（<20 字不判，避免 "Rust" 单独成段误伤），命中直接 risk 1 / high。顺带修了第 22 条：标题式大写（>60% 词首字母大写）时只认「长得像名字」的词。

## P1

### 置信度与数据正确性（项目核心卖点）

5. `src/agents/analyze.ts:169` + `src/lib/confidence.ts:127-129` — **转载检测跑在去重后的集合上**：dedupe 的 0.92 阈值已吃掉全部高相似对，findSyndicatedIds 的有效阈值是 0.9/0.8，只剩 (0.9,0.92] 窄带能命中 → 「疑似转载」恒≈0、`firstHand = 1 - syndicated/sources.length` 恒≈1，权重 0.4 直接把置信度抬进 high。→ 基于 raw 计算，或让 dedupe 回传 merged 数并把分母改成原始条数。
6. `src/lib/text.ts:34` — jaccard 对两个空集返回 1：缺 title / 纯标点条目 tokenize 出空集后互判 1.0 > 0.92，analyze.ts:43 只留第一条、其余全被吃掉，再被记成转载。→ 任一为空即返回 0。
7. `src/lib/text.ts:45-51` — hostOf 只剥 `www.`：`amp.` / `m.` / `mobile.` 算成不同 owner（independence 虚高）；解析失败全落字符串 `unknown`（把无关源并成一个 owner，反向失真）。→ 按 eTLD+1 归并，未知域名保留原串。
8. `src/lib/confidence.ts:126` — independence 只数域名：同一通稿被 10 个域名改写标题转载即 0.9643，配 firstHand 0.1 得 0.5025 仍落 medium 并展示聚合数字。→ owner 归一到首发主体，或 firstHand < 0.5 时压 low。
9. `src/lib/confidence.ts:149` — nChecked === 0 封顶 0.74，而 medium 从 0.5 起 → `allowsAggregateNumbers` 为 true：**一条事实都没交叉核对过也照出聚合数字**。→ 封到 0.49，或 allowNumbers 额外要求 nChecked > 0。
10. `src/agents/analyze.ts:187,350,370,397,410,423` — **低置信抑制只写进了 note，没写进代码**：ds-timeline / ds-hours / ds-weekday / ds-flow / ds-fresh 全部在 `if (allowNumbers)` 之外照常产出，ds-summary（独立信源 / 疑似转载 / 去重合并）也无条件产出，与 346 行那句「已抑制聚合数字与分布图，仅展示可核验的原文列表」直接矛盾。→ 这些 dataset 移进 allowNumbers 分支，低档只留原文列表 + 命中条目。
11. `src/agents/analyze.ts:158` — notes 字段无任何调用方（grep 只命中本文件与 layout.ts 的同名局部变量），sse 的 done 事件不带 notes，Workspace 也不渲染 → 「口径说明：文章数指本次检索命中的条目，不是全网总量」用户永远看不到。→ 进 done 事件并在结果页渲染，或删掉该字段。
12. `src/agents/analyze.ts:431` vs `:392` — 同名「命中条目」两处口径不同：KPI 用去重后的 `sources.length`，漏斗首级用 `raw.length`，发生合并时两个数字互相打脸。→ 统一口径或改标签。
13. `src/agents/analyze.ts:39-50` — key 为空的条目被静默丢弃却计入 `merged`，KPI 把它报成「去重合并」。→ 单独计 dropped。
14. `src/lib/schemas.ts:28` — timeRange.from/to 只要是字符串就通过，而意图由模型直接产这两个字段：给「近三个月」或空串时 `retrieve.ts:34` 得 NaN → fromMs=0（1970 起），**时间窗静默失效**，UI 仍显示「窗口 from → to」。→ datetime 校验，失败回落启发式窗口。

### 外部抓取与网络

15. `src/lib/http.ts:85-94` — 结局只由 res 的 error/end 决定：8s 超时 destroy 落到 error 分支，返回 `ok:true, truncated:false` 的**半截正文**（超时对调用方完全不可见）；若两者都不触发则 Promise 永久挂住，整条 pipeline 卡死。→ 显式区分 premature-close / timeout 并置 truncated。
16. `src/lib/http.ts:81` — 一律 `toString("utf8")`，不看 content-encoding 与 charset：GBK/Big5 站点整篇乱码，gzip 响应变二进制垃圾。→ 按 content-type 的 charset 解码，请求显式 `accept-encoding: identity` 或解压后再返回。
17. `src/agents/retrieve.ts:88-91` — `isRateLimited` 的正则含 `abort|timeout`：客户端断开与 GDELT 的 2.5s 软超时都被判成限流，进而在 81-84 行把 `gdeltCooldownUntil` 推到 now+300000 → **一次用户关页面就让 GDELT 全局冻 5 分钟**。→ 只对 429 / 明确的额度文案冷却，abort 单独区分。
18. `src/lib/llm.ts:84` — streamText 没传 abortSignal：pipeline 的 `gone()` 只是 return（关掉 generator），上游请求继续跑到结束，连接与额度照烧。→ 传入 AbortSignal 并在 finally 里 abort。
19. `src/app/api/search/route.ts:15` + `:14` — 限流表 `rlHits` 永不删除 key（每个 IP 一条永久记录）；`RL_MAX = Number(env ?? 3)` 若环境变量是非数字则 NaN → `>= NaN` 恒 false → **静默不限流**。→ 定时清理过期 key，启动时校验 RL_MAX 为有限正整数。

### 翻译

20. `src/lib/translate.ts:421` — overall 只对出问题的段求平均，段数不进分母：48 段里 1 段 0.35 与 48 段全错同为 0.35 / mid，而 UI 渲染成「平均歧义」。→ 传全量 scores 作分母，另给最高段风险与出错段数。
21. `src/lib/translate.ts:350-366` + `src/lib/lang.ts:59-62` — 语言识别失败（unknown）被写成「原文已是目标语言，未翻译 / 未调用翻译引擎」，degraded 里无标记：短英文标题整段原样展示还标 low。→ unknown 单开分支并 push `lang:unknown`，文案改「未识别语言，未翻译」。
22. `src/lib/translate-risk.ts:57-74` — 句子里每个首字母大写词都算专名，标题式大写让**正确译文**被判 mid（复算：`NVIDIA Announces New GPU…` → 正确中译反而 0.4/mid，signals.lost = [Announces, Data, Centers]）。→ **已修**：`isHeadlineCase()` 量大写词占比，过半就只认带数字/连续大写/&. 的词；同一句正确中译现在 0/low。

### 界面与交互

23. `src/components/ModuleCard.tsx:69,92-97` — 卡片外层 `overflow-hidden` 裁掉「溯源」下拉（`absolute right-0 top-7 max-h-56 w-80`）：浏览器实测 8 张卡里 h=4 的 KPI 卡（cardH=184px）浮层底部溢出 90.5px，来源列表几乎整段不可见且无滚动条。→ 去掉容器 overflow-hidden（正文自己裁），或改 portal / 向上弹出。
24. `src/hooks/useProbe.ts:98-106` + `:143-144` — run() 中断旧 reader 时不清 `pendingText`、不 `cancelFlush()`，旧轮排进 rAF 的尾部文本会 flush 进新答案；结束路径也没有 run 令牌比对，旧轮在 abort 落地前读到 done 会把刚开的新轮直接标成 done。→ run 开头清队列，并用自增 runId 在校验后落库。
25. `src/components/SearchBar.tsx:41-43` — onKeyDown 对任何 Enter 提交，没有输入法组合态判断：中文输入法按 Enter 确认候选词，会把未上屏的拼音当查询发出去。→ `if (e.nativeEvent.isComposing || e.keyCode === 229) return;`。
26. `src/components/TrendingBoard.tsx:113-116` + `src/lib/trending.ts:225` — 界面断言「GDELT 新闻索引当前出口被限流」，但代码里**从未请求 GDELT**，是 `degraded.push("gdelt")` 无条件推入，这条「原因」是编造的。→ 改「本轮未接入 GDELT」或删掉该降级项。
27. `src/components/TrendingBoard.tsx:15-19` — `toLocaleTimeString` 未指定 timeZone，而 fetchedAt 是服务端 `toISOString()` 在 SSR 渲染：部署机 UTC 与浏览器 +08:00 必然不同 → 水合不匹配 + 时刻错误。→ 固定 timeZone 或挂载后再本地化。
28. `src/lib/trending.ts:227-233` + `TrendingBoard.tsx:34,54-56` — 榜单全空时没有可读原因：`points >= MIN_POINTS` 把整批剔光时 `considered = 0` 什么都不报；`stories:empty` / `topics:empty` 无人渲染，空态文案「没有话题被两条以上报道同时提到」对「分数不足被过滤」是错解释。→ 条件改为 `topics.length === 0` 并渲染 degraded 文本。
29. `src/lib/trending.ts:131-143` — 标题短于 8 字的 story 被静默丢弃（`GPT-5` 直接消失），`fetchedStories` 报的是过滤后数量却被当分母显示「N/M 条进入统计」。→ 另记原始命中数，丢弃数进 degraded。
30. `src/components/BilingualCompare.tsx:100-102,137` — 「重新抓取并翻译」先把 status 设 loading，effect 又对 `status === "loading"` 调 load() → **一次点击发两次 /api/translate**（StrictMode 首屏同样双发），两响应竞态 setState。→ effect 只负责首次加载（ref 记已发起），按钮走独立路径。
31. `src/components/BilingualCompare.tsx:85-92,129-135` — fetch 不查 res.ok，把 429 `{ok:false,error:"rate_limited"}` 与 422 一并写进缓存，而 `!data.ok` 分支只有黄条、没有重试按钮（重试只在网络错误分支）→ 被限流后既不能重试、缓存还会继续命中。→ 非 ok 不入缓存，该分支补重试。
32. `src/components/ModuleGrid.tsx:115-128,130-186` — 窄屏/SSR 分支与网格分支父节点不同，跨 720px 阈值时全部卡片重挂载：ECharts 重建、展开的溯源/词条收起、焦点丢失。→ 两分支共用稳定父容器，只切布局类名。
33. `src/components/SettingsPanel.tsx:143-147,178-183` — `role="dialog" aria-modal="true"` 只做了外观：无初始焦点、无焦点陷阱、关闭不归还焦点、背景无 inert，键盘用户 Tab 到被遮挡的控件。→ 打开聚焦首控件 + Tab 循环 + 归还焦点 + 背景 inert。
34. `src/components/Workspace.tsx:94-99` — writeSettings 的 boolean 返回值被丢弃，而设置面板写着「改动即时生效 · 只存本机」：配额满/隐私模式下 Key 与布局没存住却无提示（对照 ModuleGrid 有 saveFailed）。→ 接住返回值并提示「本次会话外不会保留」。
35. `src/lib/runtime-config.ts:35-40` — 用户填的模型名带 `/` 或空格就被静默丢弃回落默认：`openai/gpt-4o`、`gpt 4o`、带 `@` 的网关名全部失效，界面无提示。→ 放开常见分隔符，或在设置面板对非法输入即时回显。
36. `src/lib/compile.ts:445-453` — funnel 的 `minSize: "24%"` 把小得多的末级画成至少 24% 宽，label 却显示真实数字（首级 raw、末级 24h 内 fresh，量级常差一到两个数量级）→ 图形与真值自相矛盾。→ minSize 设 2% 或 0。
37. `src/lib/layout.ts:105-117,168` — 新模块起始 y 取全部快照项（含已被丢弃的幽灵项）的 y+h 最大值；`restored === 0` 时返回的是整体下移后的排布而非默认排布，顶部一片空白且无提示。→ bottom 只按已放置项累加，restored === 0 回 defaults 并给 notice。
38. `src/lib/entities.ts:119-129` — 词典用 `query.includes(别名)` 子串匹配：`meta` 命中「metadata」、`苹果` 命中「苹果醋」、`安全` 命中「国家安全」、`eu` 命中「europe」；而注释自称「刻意不放 ai/js/ts 这类两字母别名」——eu/ios/aws/dns/tls 同样是短别名。→ 英文别名按词边界匹配，或按长度分级要求。
39. `src/agents/pipeline.ts:79-87` — `intent.ambiguity > 0.35` 只追加一句「按最宽口径先给一版面板」然后照常跑完，PRD 2.1 要求先渲澄清卡。→ 要么实现澄清卡，要么把 PRD 与文案改成现状。
40. `src/agents/pipeline.ts:117,123-137,199` — 所有模块共用 `citeIds = sources.slice(0,20)`，源列表又只取前 40 → 点「溯源」看到的不是「这个数字来自哪条」，而是前 20 条。→ 每个 dataset 从自身 rows 反推 sourceIds。

## P2（23 条，摘要）

- 性能：`analyze.ts:43` 每条都对 seenTitle 全量跑 titleSimilarity（内部每次重新 tokenize，O(n²)）；`translate.ts:189-191` 缓存超 800 整表清空，随后整批段落重打 MyMemory 配额（且 3 个并发 worker 无 in-flight 去重）。
- 数值健壮性：`compile.ts:275`（heatmap）与 `:333`（radar）任一非数值行就让 `Math.max` 变 NaN → visualMap.max=NaN 静默单色；`compile.ts:95-97` heatmap 的 value 缺失检查是死分支（`field(encode.value ?? encode.y)` 恒非空）；`analyze.ts:220` `typeof NaN === "number"` 让 NaN tone 进 tonePoints（序列化后成 null 点）；`heat.ts:122` toneBucket(NaN) 落 neutral；`heat.ts:42` mad30d=0 时除 1e-6 让分位饱和；`heat.ts:90` median30d=0 返回哨兵 99，`p95 <= 0` 时一篇文章即判 burst（注：heat.ts 除 toneBucket 外无调用点）；`text.ts:56` normalizeValue 不折算万/亿（「1.2万」vs「12000」判冲突、「3.2B」与「3.2亿」都截成 3.2 判一致）。
- 契约与校验：`schemas.ts:85` Dataset/ModuleSpec/Confidence 全仓无 parse/safeParse（只有 IntentSchema.parse），数据集未经边界校验就进 compile 取值；`analyze.ts:89` 未校验数字 claim 的 unit，按 unit 分组的一致性判定会把无单位数字并组；`llm.ts:56` 无差别重试（401/400 也再打一次，白烧额度且不留日志）；`http.ts:98` req.setTimeout 是空闲超时不是总预算，每跳重定向重新计时（最坏 4×timeoutMs）。
- 架构风险：`api/search/route.ts:114-115` 依赖 undici 同步调用 ReadableStream.start 才能让 ALS 上下文延续（现在成立，属隐式契约）；`sse.ts:75` 多行 data 逐行 trim 会剥掉 JSON 字符串值首尾的合法空格；`useProbe.ts:173-189` module.ready 找不到同 id 的 plan 时静默丢弃模块；`Workspace.tsx:103-111` pickTopic 写 `?q=` 但无 popstate 监听，浏览器后退不回结果；`layout.ts:51-54,155-160` 快照版本校验分支不可达（key 里已含 LAYOUT_VERSION），真正的隔离只靠 key 拼接；`fixtures.ts:63` fixtureClaims 无调用方（死代码，且与「不造假断言」相悖）。
- 可访问性：`Glossary.tsx:58` 词条 `span role="button"` + outline-none，键盘焦点不可见且无 aria-expanded；`SourceList.tsx:56-76` 两个切换按钮无 aria-expanded/aria-controls；`SettingsPanel.tsx` 的 Chip 与 Secret 显隐按钮无 aria-pressed。

## 建议修复顺序

1. P0 四条（SSRF、重定向异常、假配置文案、翻译 0 分）——都是「用户会看到错的东西」或「外部可达」。
2. 置信度三条（#5 #6 #7 #8 #9）——这是产品的地基，现在 firstHand 恒 1 等于把 40% 的权重送给了「没检测到转载」。
3. 低置信抑制补齐（#10 #11）——代码里已经写了承诺，只是没执行。
4. 前端交互四条（#23 #24 #25 #26）——溯源看不到、串味、输入法回车、编造的降级原因。
5. 其余 P1 按文件归并修，P2 择机。
---

## 修复记录（第二轮：全量测试 + 防御性编程）

测试基线：`node ../.probe-qa/full-api.mjs` 35 项、`python ../.probe-qa/full-ui.py` 31 项，跑在 `next start -p 3211`（`PROBE_RATE_LIMIT_PER_MIN=200`）。
本轮之前 API 34/35（notes 未外发）、UI 29/31；本轮之后 **API 35/35、UI 31/31**。

### 数据正确性
- **低置信抑制补齐**（#10）：`analyze.ts` 的 `ds-hours`、`ds-weekday` 移进 `allowNumbers`；`ds-summary` 拆成「条目计数（照出）」与「派生统计：独立信源/疑似转载/可核验断言（低档不出）」。说明与事实不再互相打脸。
- **口径说明终于能看见**（#11）：`notes` 经 `done` 事件外发（`sse.ts` 补字段、`pipeline.ts` 转发、`useProbe` 收进 state、`Workspace` 用中性色列表渲染）。另补三条新口径：低档抑制了哪些数字、`nChecked === 0` 时的封顶原因、去重合并了几条。
- **信源分布少一根柱**（#18）：阈值 `> TOP_OWNERS + 1` → `> TOP_OWNERS`，恰好 8 家时不再静默丢第 8 家。
- **同一标签两个数**：漏斗首级 `命中条目`（raw）改名 `原始命中`，KPI 侧改 `条目数`（去重后）。
- **NaN 挡住**：`tone` 判 `Number.isFinite`；出口对每个 dataset 剪掉非有限数字行再 `DatasetSchema.safeParse`，被剪记进 `degraded`（`rows:non_finite` / `dataset:invalid_*`）。
- **伪造 id 的 claim**（#8）：先 `sourceIds.filter(validIds)` 再判非空，裁空整条丢。

### 置信度
- **一致性口径**（#19）：按 `sourceId` 收敛后统计「独立来源说了什么」，单源说三遍不再算三次核对（`nChecked` 计来源数，组内来源 < 2 不参与）。
- **未核验封顶**（#20）：`nChecked === 0` 由 0.74 降到 **0.64**，稳落 medium，不再贴着高档。
- **排序键防 NaN**（#12）：`Date.parse` 不可解析时排最后，`gapHours` 不再 NaN，转载规则复活。
- **band 用舍入后的分数**：0.74996 不再显示 0.75 却算 medium。

### 文本与实体
- **中文 bigram 去空格**（#21）：「华为发布新机」与「华为 发布 新机」现在同一集合（Jaccard 从 0.43 → 1）。
- **空集不再相等**（#16）：`jaccard` 任一为空返回 0，空标题不再互相吞并。
- **owner 取 eTLD+1**（#17）：`news.x.com` / `amp.x.com` 归一家，二级后缀（co.uk / com.cn …）保留三段，解析失败保留原串。
- **数量级折进数值**（#23）：`3.2 billion` → 3200000000，`1.5万` → 15000；中文刻度与英文刻度分开映射（亿 = 1e8、billion = 1e9）。
- **别名要词边界**（#15）：`meta` 不再命中 `metadata`、`eu` 不再命中 `europe`。

### 网络与抓取
- **半截正文不再当成功**（#14）：`getDirect` 只有在按字节上限主动截断时回 `ok:true`，传输中断回 `fetch_failed`、超时回 `timeout`。
- **客户端断线不再冻 GDELT**（#13）：`isRateLimited` 先排除 abort，关标签页不会再让 GDELT 冷却五分钟。

### 前端与状态
- **串味与竞态**：`useProbe` 加轮次令牌 `seqRef`（读流每轮、`applyEvent`、catch、收尾都校验），`run()` 清 `pendingText`，卸载真 abort，流末补解码器尾巴（末条无空行时 `done` 不再丢）；`module.ready` 无对应 plan 时补插一张卡。
- **快照**：`layout.ts` 兼容本机存 `"null"`（原来抛 TypeError 崩整个网格）、`restored === 0` 回默认排布、`saveLayout` 落盘前 clamp 而不是"夹不进去就报存不下"。
- **收起全部方向**：`ModuleGrid.toggleAll` 改判 `every(collapsed)`，换查询后旧 id 残留不再让文案与动作相反。
- **对照面板**：只缓存成功结果（`CACHE_MAX = 24` 先进先出）、`AbortController` + `!res.ok` 判失败、自动加载只发一次（一次点击不再双发）、`!ok` 分支也能重试；每段加 `data-seg`（分段与配色是两个概念，没有引擎时只分段不上色）。
- **设置写盘失败能看见**：`updateSettings` 返回 boolean，面板顶部给 `role="status"` 的提示。
- **实体图的无障碍入口**：默认视图也给一排 `data-entity-chip` 按钮（画布键盘到不了）。

### 校验
- `IntentSchema.timeRange` 改成真日期校验（`YYYY-MM-DD` 或 ISO 时间戳 + 日历自检 + `from <= to`）；规则路径给 ISO、模型给日期，两种都收。

### 仍未修（下一轮）
- （第二轮列的七条已在第三轮清空，见下）

## 修复记录（第三轮：P2 清单 + Cron 与历史导航）

### 性能与内存
- **`dedupe` 的 O(n²) 标题比对**：改按 token 数分桶（`bucketOf(n) = floor(log2(max(1,n)) * 2)`），
  只与同桶及左右邻桶比。Jaccard > 0.92 要求 min/max ≥ 0.92 ⇒ token 数对数差 ≤ 0.12 ⇒ 桶差 ≤ 1，
  所以这是**等价压缩**而不是近似。400 组随机标题（含中文 bigram、英文大小写变体）与旧全量比较零处不一致。
- **`translate` 缓存整表清空**：写满时删最老的一半（按插入序），不再 `clear()`。清空会让正在读的
  同一篇文档下一段全部重翻，而 MyMemory 有每日配额。

### 图表与数值
- **`compile` heatmap / radar 的 NaN 上限**：缺数据行是 `null`/`""`，`Math.max` 吃进 NaN 会把整根轴写坏。
  改成只对 `Number.isFinite` 的值取 `Math.max(1, …)`。
- **`heat.ts` 的哨兵 99**：新增 `RATIO_CAP = 9.99`，`ratio7d()` 与 `seriesStats().r7` 都夹到它。
  99 会出现在排序与文案里，读者会当成真实倍数；`1e-6` 保留（只用来挡 MAD=0，Infinity 会让百分位链变 NaN）。

### 无障碍
- `SourceList` 的「原文片段」「对照原文」加 `aria-expanded` + 带标题的 `aria-label`；
  `SettingsPanel` 的 `Chip` 加 `aria-pressed`。

### 网络重试
- `llm.ts` 的 `generateStructured` 不再无差别重试：`isTransient(err)` 只对 408/409/425/429/5xx/网络类
  错误重试一次，401/403/400/404 与「key 无效 / 模型不存在」直接放弃（重试只是把同一个错误再说一遍）。
- `trending.ts` 的 HN 抓取给一次重试（800ms 间隔）：实测同一分钟内前一次成功、后一次
  `The operation was aborted due to timeout`。两次都空才记 `hn:failed`。

### 历史导航
- `Workspace` 的 `popstate` 现在真的能回到上一次结果：所有界面发起的检索统一走 `startSearch()`
  （先 `run` 再 `pushState`），「新建搜索」用 `replaceState` 清 `?q=`。
  实测 Rust → OpenAI → 后退回到 `?q=Rust` 且 7 张卡都在，前进回到 OpenAI 同样 7 张。

## 修复记录（第四轮：P1 剩余清单）

### 网络与抓取
- **正文按 charset 解码**（`http.ts`）：请求头显式 `accept-encoding: identity`；新增 `decodeBody()`，
  按 `content-encoding` 用 `gunzip/inflate/brotliDecompress`（解不开就按原样），再按 `content-type` 的
  `charset=` 用 `TextDecoder` 解码。原来一律 `toString("utf8")`，GBK/Big5 站点整篇乱码，
  而下游还在乱码上切句、比数字、比专名 —— 那比直接失败更糟。
- **重定向坏 Location 不再 500**（第三轮已修）：`new URL(location, parsed)` 包了 try，非法跳转回 `invalid_redirect`。

### 限流
- `api/search` 的 `PROBE_RATE_LIMIT_PER_MIN` 走 `readLimit()`：空/非数字/≤0 时打一行 warn 并回落默认值。
  原来 `Number("abc")` 是 NaN，而 `recent.length >= NaN` 恒 false —— 一个笔误的环境变量会**静默关掉限流**。
- `hitRateLimit` 在表大于 512 条时清掉全部过期 key（原来每个 IP 一条永久记录）。

### 指标与文案的口径
- **`trending` 的分母**：新增 `rawStories`（上游原始命中数），页面改「considered / raw 条进入统计」；
  标题太短被丢时记 `degraded: stories:short_title`。原来分母是过滤后的条数，「3/3 条进入统计」看着健康，
  其实上游给了 300 条、297 条被悄悄丢掉。
- **`TrendingBoard.fmtTime` 固定 `Asia/Shanghai`**：时间戳由服务端渲染，不指定时区时部署机（UTC）与
  浏览器（+08:00）会算出两个字符串 —— 水合警告，以及「更新于 11:30」其实是 19:30。
- **`translate` 的平均歧义**：`overall` 回到 `overallRisk(scores)`（全部段落作分母）。原来只对「有风险」的段求平均，
  48 段错 1 段与全部译错同分，而界面写的是「平均歧义」。
- **认不出语言不再冒充「原文已是中文」**：`from === "unknown"` 时记 `degraded: lang:unknown`、
  信号 `lang_unknown`，面板文案改「只做分段，不翻译、不上色」。
- **模型名不再被静默丢弃**：`cleanModel` 放行 `/` 与 `@`，长度 2..80。原来 `openai/gpt-4o`（网关写法）
  与 `gpt 4o` 都会变成「没填」，用户只看到模型没换、没有任何提示。
- **funnel 的 `minSize` 24% → 2%**：末级被放大到 24% 宽而 label 写真实数字，图形与真值自相矛盾。
- **溯源的证据集对齐**：`pipeline` 的 `citeIds` 由 `slice(0,20)` 改成 `slice(0,40)`（与信源列表同上限），
  浮层顶部写明「本轮证据 N 条 · 面板是聚合结果」。原来卡片只认前 20 条，比下面列出的信源还少。

### 资源与无障碍
- **模型请求可被 abort**：`streamSummary(prompt, sink, signal)` 把 `AbortSignal` 传给 `streamText`；
  `pipeline` 用一个 `AbortController`，`gone()` 时 abort、`finally` 里兜底。
  原来 `gone()` 只是 `return`，上游照样跑到结束 —— 线程与额度都在没人听的时候烧掉。
- **设置抽屉的焦点陷阱**：Tab 首尾相接、打开时把焦点送进抽屉、关闭时还给原来的元素（`aria-modal` 才算数）。

### 仍未修（明确的取舍）
- **#32 跨 720px 阈值整批重挂载**（`ModuleGrid` 单列回退与网格是两棵树）：修它要把窄屏也塞进 `GridLayout`
  并重排高度语义，收益是一次罕见的窗口缩放少一次 ECharts 重建 —— 风险大于收益，留着。
- **#40 逐条数字 → 单条信源的映射**：面板是聚合结果（按日文章数来自 39 篇），没有可给的逐条映射；
  本轮把上限与文案改诚实，真正的逐条指认要等 dataset 带上 `sourceIds` 行级归属。