# 交接文档 · 探针（Probe）

> 给下一个窗口的接手者。读完这一页就能干活，不用重读代码。
> 最后更新：2026-10-24，对应 `main` @ `56f442b`。

## 1. 一句话现状

**探针**是一个「先给证据、再给结论」的情报看板：用户问一句话 → 联网检索 → 本地流水线算置信度 → 出数据面板 + 信源 + 双语对照。前端是极简黑白蓝数据终端，后端是 Next.js App Router + SSE 单连接流式。

已经上线：**http://106.52.116.164/probe**（挂在现有服务器的 80 端口子路径下，每 5 分钟自动更新）。本地 `main` 与远端一致，工作树干净。

## 2. 三分钟接管

```bash
cd C:/Users/ayuan/Desktop/WORK/探针
npx tsc --noEmit                       # 必须 0
rm -rf .next && npx next build          # 必须通过
PROBE_RATE_LIMIT_PER_MIN=200 npx next start -p 3211   # 本机 prod
node  C:/Users/ayuan/Desktop/WORK/.probe-qa/full-api.mjs http://127.0.0.1:3211   # 期望 35/35
PYTHONIOENCODING=utf-8 python C:/Users/ayuan/Desktop/WORK/.probe-qa/full-ui.py http://127.0.0.1:3211  # 期望 31/31
```

**限流默认 3 次/分钟**，反复跑 Playwright 会 429，表现成「组件坏了、`[data-module-id]` 90 秒超时」。测浏览器一律用 `PROBE_RATE_LIMIT_PER_MIN=200`。

## 3. 代码地图

技术栈：Next 16.4（App Router、Turbopack）、React 19、Tailwind v4、ECharts 6 + echarts-for-react、framer-motion 14、lucide-react、zod 4、ai 7（`@ai-sdk/openai`）。零数据库、零 ORM —— **所有持久化都在本机 localStorage 与服务器文件系统**。

### 流水线（一次检索）

```
POST /api/search {query}
  runPipeline()                 src/agents/pipeline.ts
   ├─ routeQuery()              src/agents/route.ts      → Intent（含 ambiguity）
   ├─ buildClarify()            src/lib/polysemy.ts      → 歧义澄清卡（可选事件）
   ├─ retrieve()                src/agents/retrieve.ts   → RawSource[]（HN + Tavily + Wiki）
   ├─ analyze()                 src/agents/analyze.ts    → Dataset[] + Claim[] + Confidence
   ├─ compose()                 src/agents/compose.ts    → ModuleSpec[]（只引用 dataset）
   ├─ buildEntityGraph()        src/lib/entity-graph.ts  → 共现邻接表 + 2 跳
   └─ streamSummary()           src/lib/llm.ts           → 摘要（无 key 走本地模板）
SSE 事件序：intent → [intent.clarify] → module.plan×N → module.ready×N → text.delta… → sources → entity.graph → done
```

### 目录（行数）

| 位置 | 干什么 |
| --- | --- |
| `src/agents/` | pipeline 302 / retrieve 387 / analyze 551 / compose 156 / route 95 |
| `src/lib/` | schemas 185 · confidence 180 · text 110 · http 300 · llm 202 · sse 105 · trending 322 · heat 252 · heat-history 298 · topic-terms 95 · translate 444 · translate-risk 251 · lang 78 · entity-graph 370 · entities 175 · polysemy 244 · layout 235 · settings 124 · module-catalog 134 · module-plan 211 · metrics 232 · placement 69 · runtime-config 86 · base-path · version |
| `src/components/` | Workspace 679（唯一的树：首页与结果页是同一批元素在移动）· ModuleCard 349 · TrendingBoard 314 · ModuleGrid 315 · SettingsPanel 371 · BilingualCompare 348 · EntityGraphCard 348 · ConfigDocs 247 · ModulePrompt 245 · FeedbackButton 232 · MetricsPanel 283 · Glossary 204 · ModuleDock 179 · ProbeLogo 160 · SearchBar 139 · ConfidenceBadge 117 · ClarifyCard 111 · SourceList 97 · ChartBox 82 · UpdateBanner 101 |
| `src/app/api/` | search 154 · translate 68 · module 181 · feedback 103 · metrics 36 · version 30 · cron/heat |
| `src/hooks/useProbe.ts` | 328 —— SSE 客户端 + 状态机（rAF 合帧、轮次令牌、clarify/notes/entityGraph） |

## 4. 铁律（改代码前先读，都是踩出来的）

1. **无源不显示，缺失不填 0。** 算不出来的数字与图直接不出，不降级成 0 或示例数据。
2. **低置信抑制聚合数字与分布图**（`allowsAggregateNumbers`），只出条目级信息；抑制时必须在 `notes` 里说明。
3. **置信度不用模型自评。** 三分量 0.40 一手性 / 0.35 独立性 / 0.25 一致性；`nChecked=0` 封顶 **0.64**，`demoOnly` 0.34，owner<2 封顶 0.45。
4. **独立性单位是 owner，不是域名**（`src/lib/text.ts` 的 `hostOf` 取 eTLD+1，`SECOND_LEVEL` 表处理 co.uk/com.cn…）。
5. **数值先折算数量级再比**：`亿=1e8`、`billion=1e9`、`万=1e4`、`K=1e3`。写错一个数量级会让「一致/冲突」全反。
6. **`notes` 必须外发到前端**（`done.data.notes`），否则口径说明永远没人看见 —— 这是曾经的 P0。
7. **不编造原因。** 降级码只写事实（`gdelt:not_configured`、`hn:failed`、`history:building`），不在 UI 里替上游编理由。
8. **`table`/`kpi` 不走 `compile()`**（它会返回 `unknown_kind`），自定义面板这两类要跳过校验。
9. **图表必须定高**：ECharts canvas 的 `height:100%` 只在父元素高度确定时生效；`ChartBox` 用绝对定位 + 父级 `h-[360px]` 这类定高容器。
10. **自定义 CSS 留在 `@layer base`**：无层级规则会压掉 Tailwind utilities；`backdrop-filter` 只写无前缀一条（Lightning CSS 会删）。
11. **流式文本不能用 `textStream`**：provider 错误会被吞成空流。用 `fullStream` 逐 part 计数。
12. **内网 URL 一律不抓**（SSRF）：`getDirect` 入口 `hostAllowed()` 逐跳复检，DNS 解析出私网即拒。

## 5. 关键公式与阈值

- 置信度：`score = 0.40·firstHand + 0.35·independence + 0.25·consistency`；`independence = 1-e^(-n/3)`。
- 热度：`score = (0.6·pct(量级) + 0.4·pct(偏离)) × exp(-ageHours/36)`；状态 `long-tail`（最先判）→ `burst`（r7>2 且条数≥p95）→ `rising`（r7>1.3）→ `stable`（≥0.8）→ `decaying`；序列不足 14 天不出标签；`r7` 上限 9.99。
- 去重：URL 相同合并；标题 Jaccard **> 0.92** 判重（分桶压缩：token 数 `floor(log2 n · 2)` 相邻桶比）。
- 翻译歧义：`risk = 1-Π(1-w)`，band <0.3 low / <0.6 mid / else high；整段未译直接 1.0。
- 基线：HN Algolia 直方 30 天、12h 窗、UTC 日界、`points>=2`、同日按 URL 去重、落 `.cache/hn-history.json`。

## 6. 测试资产（都在 `C:/Users/ayuan/Desktop/WORK/.probe-qa/`，不在仓库里）

| 脚本 | 用途 | 期望 |
| --- | --- | --- |
| `full-api.mjs <base>` | 35 项接口断言（SSE 事件序、三类接口的脏输入必须 <500） | 35/35 |
| `full-ui.py <base>` | 31 项 UI 断言（首页几何、过渡、拖拽落盘、收起全部、tooltip、设置、对照、后退） | 31/31 |
| `mobile-audit.py <base>` | 390/360 两种宽度六个界面，`scrollWidth == vw` | 无溢出 |
| `heat.py` `board.py` `hero.py` `clarify.py` `cfgdocs.py` | 专项视觉/行为断言（读 computed style，不读图） | 见各脚本 |
| `brand.mjs` `brand-png.py` `brand-check2.py` | 品牌 SVG 生成 / 出 PNG / 量留白 | 见 `docs/brand/README.md` |

**读图不可用**（模型不吃 image input），视觉校验一律用 `getBoundingClientRect` + `getComputedStyle` 断言；截图只给人看。

## 7. 部署与运维（已跑通，别重造）

| 项 | 值 |
| --- | --- |
| 服务器 | `ayuanjc-1` = `106.52.116.164`，root，SSH key 登录（本机 `ssh ayuanjc-1`） |
| 站点 | http://106.52.116.164/probe （`/probe/` 会 308 到 `/probe`，正常） |
| 源码/构建 | `/opt/probe/app`（node_modules 约 556M） |
| Node | `/opt/node/bin/node` v22.23.4（官方 tarball，没走 apt） |
| 进程 | systemd `probe-web.service` → `next start -H 127.0.0.1 -p 3215`，`EnvironmentFile=/opt/probe/probe.env` |
| nginx | `/etc/nginx/sites-enabled/yunying`，新增 `location /probe { proxy_pass http://127.0.0.1:3215; … proxy_buffering off; proxy_read_timeout 300s; }`（**proxy_pass 不能带 URI**，带了会剥前缀） |
| 自动更新 | `/opt/probe/update.sh` + `probe-update.timer`（5 分钟）→ 取 `api.github.com` 的 sha → `codeload.github.com` 下 tarball（**服务器 `git clone` 不通**：`GnuTLS recv error`）→ 覆盖源码 → lock 变了才 `npm ci` → `PROBE_DIST_DIR=.next-staging` 构建 → 换目录 → 重启 → 自检失败回滚 |
| 热度定时 | `probe-heat.timer`（30 分钟）→ `/opt/probe/heat-cron.sh` → `POST /probe/api/cron/heat`（带 `x-probe-cron-secret`，不配 secret 直接 503） |
| 日志 | `/var/log/probe-update.log`、`/var/log/probe-heat.log`、`journalctl -u probe-web` |
| env | `PROBE_BASE_PATH=/probe`、`NEXT_PUBLIC_PROBE_BASE_PATH=/probe`、`PROBE_SITE_URL=http://106.52.116.164`、三条限流、`PROBE_CRON_SECRET`、`NODE_ENV=production` |
| npm | `registry=https://registry.npmmirror.com`（npmjs 要 14s，镜像 1.7s） |
| 构建耗时 | 服务器约 **32 秒**（比本机快） |

运维三个常用动作：

```bash
systemctl start probe-update.service   # 立刻更新一次
tail -f /var/log/probe-update.log      # 看「ok: 线上已是 <sha>」
curl -s http://127.0.0.1:3215/probe/api/version   # buildId 变了就是新版在跑
```

**回滚**：`.next-old` 在自检通过后即删；要回滚就用旧 sha 手工装（`codeload.github.com/ayuanjc/Probe/tar.gz/<sha>`），步骤见 `docs/DEPLOY.md`。

## 8. 坑清单（Windows / MSYS / Next / 工具）

1. **MSYS 会改写环境变量里的路径**：`PROBE_BASE_PATH=/probe` 变成 `C:/Users/…/probe`。设这类 env 必须用 `pwsh` 工具，不能 bash。
2. **停 3211 的 Node 必须写死 pid**：`netstat -ano | grep LISTENING | grep ':3211'` 取 pid → `powershell -NoProfile -Command "Stop-Process -Id <pid> -Force"`。`$pid` 经 bash 会被先展开成空，命令静默失效，旧进程继续占端口，新构建起不来且旧进程返回 500。
3. **`next dev` 与 `next build` 不能同跑**（抢 `.next`），会让 dev 侧请求空响应、QA 误判成功能坏了。
4. **`tools.edit` 的 old_string 必须逐字一致**，且与 new_string 相同时会抛错并中断整个 run_code（前面的 edit 已生效，要重新核对文件状态）。
5. **在 run_code 的字符串里写正则 `\b` 会变成退格符**，改文件用 python raw string 更稳。
6. **Playwright**：`<details>` 折叠时 hover 内部元素会 TimeoutError（假缺陷）；RGL 拖拽必须 16 步小位移 + 每步 wait，一次大步跳不触发 `onDragStop`；JS 字符串里的 `\n` 会被 Python 转成真换行（用 `chr(10)`）。
7. **Windows python 输出中文要 `PYTHONIOENCODING=utf-8`**，且读不了 MSYS 的 `/tmp`（临时文件放 `C:/Users/ayuan/Desktop/WORK/.probe-qa/`）。
8. **Next 的 basePath 只改写路由与 `/_next`**：客户端手写 `fetch("/api/…")` 要用 `appPath()`；手写的元数据 URL 要手动拼 `BASE_PATH`（og:url 曾经生成裸域名）。
9. **`/probe/` 的 308 与 SSE**：nginx 必须 `proxy_buffering off`，否则摘要会一次性吐完。

## 9. 文档索引

| 文件 | 内容 |
| --- | --- |
| `README.md` | 全项目的设计理由（视觉/性能/交互/热度公式/实体图/翻译/一句话生成/部署/分享卡），改代码前先对应章节 |
| `docs/PRD.md` | 产品需求，Phase 1–3 都已完成，每节末尾有「🔧 实现备注」写与原文的差异 |
| `docs/CODE-REVIEW.md` | 五轮审查记录：4 P0（已修）+ 36 P1 + 23 P2，末尾按轮次记「已修/仍未修」 |
| `docs/DEPLOY.md` | 服务器拓扑、env 表、更新六步、回滚、四个部署坑 |
| `docs/brand/` | 抖音用矢量资产（9 个比例）+ PNG + README |

## 10. 还没做的事

### 10.1 当前明确待做：文档溯源与置信度核查（用户已提需求，架构方案还没交付）

用户要求（原话要点）：用户粘贴/上传一篇长文 → 拆成原子事实单元 → 联网检索比对 → 算出**置信度**与**吻合度** → 逐段高亮「事实 / 幻觉 / 谎言」，A+ 到 F 评级；要求多 Agent 链路（声明拆解 / 证据检索 / NLI 比对 / 加权聚合 / 社会传播学加权），**不要用一句 Prompt 让模型打分**；先出架构方案（数据流转图 + Supabase 表 + 两段 System Prompt），确认后再写码。

**接手时我尚未交付方案。已定的设计方向（可直接沿用，也可推翻但要写理由）：**

- **三个口径必须拆开**：`吻合度 fidelity`（被支持的权重 ÷ 有判断的权重）、`可核验率 coverage`（可核验声明 ÷ 全部声明）、`置信度 confidence`（证据质量 × 独立 owner 数 × 吻合度）。**不合成单一百分比**，四个数各自报，避免「可信度 87%」这种假精确。
- **「查无实据」不等于「被反驳」**：三态 `support / contradict / neutral`；无证据只降 coverage 与 confidence，不给「谎言」标签。用户原话把两者并列，实现上必须分开配色与措辞。
- **无证据 → confidence = 0**，grade 记 `N/A（未核验）` 而不是 F。
- 声明拆解：单谓词 + 可核验值；剔除观点/预测/修辞/因果；引述单列 `attribution`；每条必须带 `quote`（模型只给原文逐字片段，**字符偏移由服务端 `indexOf` 计算**，不信模型数位置）。
- NLI：用 `generateStructured` 走小模型，`claim × top-3 evidence`，输出 `{label, confidence, evidence_span, conflict_kind}`；数值比较先 `magnitudeOf/normalizeValue`（复用 `src/lib/text.ts`）。
- 证据质量：owner 权威度 × 相关性（token 覆盖）× 时效；独立性复用 `1-e^(-n/3)`；去重复用现有 URL + 标题 Jaccard 0.92。
- 社会传播学：只做「**高热低证据**」候选标签，数据来自现有 `trending` 的 `heatScore/status`；**争议态（正负情感对立）做不了** —— GDELT DOC API 全局限流 429，没有 tone 数据就不上这一档（与 PRD 既有结论一致）。
- 持久化：仓库现在**没有 Supabase/Postgres**。方案里给 Supabase 表结构（`documents / doc_segments / claims / evidences / nli_verdicts / claim_verdicts / document_scores / retrieval_runs`），但落地先走「本机 `.cache/verify/<docId>.json`」等价结构，换存储层只改一层接口 —— 与「布局快照先落 localStorage」同一套说辞。
- 事件：新增 `POST /api/verify`，SSE 事件 `doc.parsed → claim.extracted → evidence.retrieved → nli.verdict → doc.scored → done`，与现有 `/api/search` 同构，前端复用 `useProbe` 的写法。
- 前端：左原文右证据的对照视图，段落左边框三色（支持=蓝 / 反驳=红 / 无证据=中性灰虚线），Tooltip 复用现有 `Glossary` 的 portal 定位（`src/lib/placement.ts`）。

### 10.2 明确不做的两处（已在 `docs/CODE-REVIEW.md` 写清取舍）

- `#32` 网格跨 720px 重挂载：窄屏与网格是两棵树，收益小于风险。
- `#40` 逐条数字 → 单条信源：聚合面板没有行级映射，要等 dataset 带行级 `sourceIds`。

### 10.3 环境依赖缺口

- 本机没有 `.env.local` → 无 `OPENAI_API_KEY`：摘要走本地模板，`llmEnabled() === false`。想验证模型链路要临时起进程带 key。
- MyMemory 公共翻译接口有每日配额，用尽当天 `engine: none`（UI 已如实提示，不是回归）。
- GDELT DOC API 本机与服务器都 429，争议态与 tone 相关功能一律不做。

## 11. 新窗口第一句话（复制即用）

```
读 C:/Users/ayuan/Desktop/WORK/探针/docs/HANDOFF.md 和 README.md 的「交互」「热度公式」两章，然后按 10.1 的要求先出架构方案，不要写代码。
```
