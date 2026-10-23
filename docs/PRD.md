# “探针（Probe）”产品需求文档（PRD）V1.1

> 版本：V1.1（工程化修订版）　技术栈：Next.js（App Router）+ TypeScript + Tailwind CSS
> V1.0 原始存档：[PRD-v1.0.md](PRD-v1.0.md)
> 评审依据：[PRD-评审建议.md](PRD-评审建议.md)　数据源实测：[可行性分析.md](可行性分析.md)
> 约定：正文中带 `🔧 V1.1` 标记的段落是本次修订新增或重写的内容；无标记段落与 V1.0 一致。

---

## 0. 变更记录

| # | 位置 | 变更 | 原因 |
|---|---|---|---|
| 1 | 2.2 | 置信度改为 **独立性 / 一手性 / 一致性** 三分量加权，NAS 仅保留为理论参照 | 原“交叉印证收敛度”会奖励转载抄袭（假共识），与“不编造事实”冲突 |
| 2 | 2.2 / 7 | 新增 **4 条硬规则**（可溯源、无源不显示、缺失不填 0、徽章可展开） | 把“高置信度”变成可验证的工程约束 |
| 3 | 2.3 | 热度公式重写为**同量纲加权 + 整体衰减**的可计算式；补齐状态阈值表 | 原式量纲不可加、量级不衰减，榜单会被历史热点垄断 |
| 4 | 2.3 | 争议态的情感数据源明确为 **GDELT GKG tone**（原生字段），并定义“争议”判据 | 情感判定本身是幻觉源，不能含糊 |
| 5 | 2.4 | LLM 不再直接输出 ECharts option，改为输出**受限图表 DSL**，由前端编译器生成 option | 幻觉的真实形态是“语法合法但语义错”，原始容错覆盖不到；同时省 token |
| 6 | 附 A | 新增 **SSE 事件契约** | 渐进式渲染缺协议，前端无法实现 |
| 7 | 2.1 | 新增**意图澄清卡**（歧义消解） | 意图二分的真实失败模式是 query 歧义，而非分类错误 |
| 8 | 2.2 / 3 | 补**结构化抽取**策略与降级路径 | 从网页摘要到数据点是 MVP 最大的工程风险，原文缺失 |
| 9 | 4 | **移除 LangChain.js**，编排层只用 Vercel AI SDK + 显式流水线 | 两套流式抽象混用会导致编排状态与输出不同步 |
| 10 | 6 | 新增**非功能需求**章节（成本 / 缓存 / 限流 / 可观测 / 合规 / 空态） | 原文全篇未提，无法估算可运营性 |
| 11 | 8 | 热点榜 v0 提前至 Phase 2；Neo4j 延后，实体图先用 Postgres 邻接表 + pgvector | 热点榜是无 query 回访入口；多一个图库是多一套运维 |

---

## 1. 产品概述

**产品定位**：面向 Geek 群体的 AI 原生高置信度情报终端。打破传统搜索引擎的“链接列表”模式，通过意图识别与多 Agent 协同，实时生成多维度的结构化数据面板（Generative UI）。

**目标用户**：极客、研究员、投资者、开发者（对数据来源敏感、容忍生成等待时间、偏爱自定义探索）。

**核心差异化**：

- **高置信度**：不编造事实，算法校验信源，拒绝 AI 幻觉。
- **生成式 UI**：搜索即生成动态仪表盘，而非返回死板网页。
- **克制分析**：默认只展示高密度数据与图表，用户主动追问时才进行 AI 深度分析。

🔧 **V1.1 定位边界（必须守住）**：本产品**不做事实裁决（fact adjudication），只做来源透明度（source transparency）**。系统输出的是“这些数字来自哪些独立信源、它们互相印证到什么程度”，而不是“这是真的”。所有 UI 文案与置信度语义都必须服从这条边界——**置信度低时降级为原文列表，绝不是“给你一个更保守的结论”**。

---

## 2. 核心功能需求（Functional Requirements）

### 2.1 意图解析与搜索路由

**查询分类**：利用轻量级模型对用户 query 进行意图二分：

- **Lookup（查找型）**：如“苹果 2025 Q3 财报”。优先返回高度结构化的核心数据卡片（KPI、时间线），不强行生成大满贯面板。
- **Exploratory（探索型）**：如“固态电池前景”。启动完整 Agent 流水线，生成包含新闻列表、讨论度趋势、全球分布地图的复合面板。

**面板适配性判定**：规则 + 小模型判定，对于无需图表的查询（如查高铁时刻表），直接降级为高质量文本摘要。

🔧 **V1.1 意图澄清卡（歧义消解）**：二分类的真实失败模式不是“分错类”，而是 query 本身有歧义（“苹果”= 公司 / 水果；“固态电池”= 技术路线 / 概念股 / 产业链）。因此：

1. Router 输出 **`Intent`** 结构，包含 `entities[]`、`timeRange`、`dimensions[]`、`ambiguity ∈ [0,1]`。
2. `ambiguity > 0.35` 时，**先出一张澄清卡**（不是弹窗）：列出解析出的实体与候选实体、时间窗、拟展示的维度，用户可一键改，也可直接忽略继续。
3. 澄清卡本身的渲染成本必须 < 300ms（纯规则 + 一次小模型调用，不得串行等待检索）。

**字段定义**：

```ts
type Intent = {
  kind: "lookup" | "exploratory" | "no-panel";
  entities: { name: string; candidates?: string[]; type: "org" | "person" | "tech" | "event" | "metric" }[];
  timeRange: { from: string; to: string };       // ISO
  dimensions: ("trend" | "distribution" | "geo" | "sentiment" | "timeline" | "kpi")[];
  ambiguity: number;                             // 0~1
  language: string;
};
```

### 2.2 数据检索与置信度算法

- **多源并发检索**：Tavily API / GDELT / Wikipedia pageviews / HN Algolia 并发抓取，**单源超时 6s，任一源失败不阻塞整体**。
- 抓取结果统一归一化为 `RawSource`：

```ts
type RawSource = {
  id: string; url: string; canonical?: string;
  domain: string; owner: string;        // owner = 媒体集团 / 稿源归属，用于独立性判定
  title: string; snippet: string; lang: string;
  publishedAt: string; tone?: number;   // tone 仅 GDELT 提供
  provider: "tavily" | "gdelt" | "wiki" | "hn";
};
```

🔧 **V1.1 置信度打分系统（三分量，替代原“权威度 + NAS 收敛度”）**

理论上“多信源对同一事件核心属性的收敛度”参考了网络议程设置（NAS）的思路，但 NAS 是传播学理论，**不是事实验证方法**：收敛度高只说明信源之间说法一致，十家媒体转载同一通稿即可拿满分（假共识）。因此改为三个可独立计算、可解释的分量：

| 分量 | 含义 | 计算 | 权重 |
|---|---|---|---|
| **独立性 I** | 有多少个互不隶属的信源 | 域名 → `owner` 归并后得 `n_owners`；`I = 1 - Math.exp(-n_owners / 3)` | 0.35 |
| **一手性 P** | 一手发布 vs 转载 | 转载判定：canonical 相同 或 标题相似度 > 0.90 或 发布时间晚于首条 > 6h 且内容重合 > 0.8；`P = 1 - n_syndicated / n_total` | 0.40 |
| **一致性 C** | 去重后独立源在 (实体, 数值, 时间) 上是否吻合 | `C = 1 - n_conflicts / n_checked`；**必须先完成去重**，否则无意义 | 0.25 |

```
confidence = 0.40 * P + 0.35 * I + 0.25 * C
软约束：n_owners < 2  → confidence 强制降为 min(confidence, 0.45)
```

**分档与 UI 行为（必须与颜色、行为一一对应）**：

| 档位 | 区间 | UI |
|---|---|---|
| 高 | ≥ 0.75 | 绿色徽章，数字正常展示 |
| 中 | 0.50 – 0.75 | 琥珀徽章，数字旁加“待印证”角标 |
| 低 | < 0.50 | 灰色徽章，**只展示原文列表，不展示聚合数字** |

🔧 **V1.1 四条硬规则（“不编造”的工程化落地，不可协商）**

1. **可溯源**：面板上任意一个数字，点击 ≤ 2 次必须能看到原始出处（URL + 原文片段 + 抓取时间）。
2. **无源不显示**：抽不出原文支撑的数字，不显示。绝不显示为 0。
3. **缺失不填 0**：数据缺失显示“数据缺失 / 该源不可用”，不得显示“暂无数据”（后者会被读成“确实没有”）。
4. **徽章可展开**：置信度徽章必须能展开为信源清单：每个 `owner`、该 owner 下的文章、一手/转载标记、参与计算的分量值。**不可展开的徽章视为未实现**。

🔧 **V1.1 结构化抽取（原文缺失的关键环节）**

Tavily 返回的是网页摘要文本而非结构化数据，从“摘要”到“数据点”是 MVP 最大的工程风险。规格如下：

1. 抽取 = **一次** `generateObject`（JSON mode）+ zod 强校验，`temperature: 0`，最多重试 1 次。
2. 校验失败 → 降级为“原文卡片列表 + 摘要”，**不留空白面板**。
3. 每个抽取字段必须携带 `sourceIds` 与 `quote`（原文片段）；无 `quote` 的字段一律丢弃。
4. 数值字段必须带单位与量纲；跨源单位不一致时该字段不参与一致性计算，只展示不聚合。

### 2.3 热点雷达与状态计算

- **公共热度榜**：被动搜索模式，后台定时任务（Cron）计算 Top N 榜单。
- **命中展示**：用户搜索词命中榜单时，直接挂载热度状态徽章。

🔧 **V1.1 热度公式（可计算版本，替代原式）**

原式 `Magnitude + Deviance × 时间衰减因子` 存在两个硬缺陷：Magnitude（无上界的文章量）与 Deviance（0~3 量级的偏离度）量纲不同不可相加；衰减只作用于 Deviance 会使历史热点永久霸榜。改为：

```
articles_24h = 该 topic 近 24h 文章数
median_30d   = 该 topic 前 30 天日均文章数
MAD_30d      = 前 30 天日文章数的中位绝对偏差（稳健离散度，抗离群）

Mag   = log1p(articles_24h)                              # 压缩量纲
Dev   = (articles_24h - median_30d) / (MAD_30d + 1e-6)   # 稳健 z-score

raw   = 0.6 * pct90(Mag) + 0.4 * pct90(Dev)              # 两项各自按 90 天分位归一 → 同量纲后加权
score = raw * exp(-age_hours / 36)                       # 衰减作用于整体；age_hours = 最近一篇文章距今
```

**状态标签阈值（写死，供后台任务与验收共用）**：

```
r7 = 近 7 日均值 / 前 30 日均值
爆发期：r7 > 2.0 且 articles_24h 处于 90 天 Top 5%
升温期：1.3 < r7 <= 2.0
平稳期：0.8 <= r7 <= 1.3
回落期：r7 < 0.8
长尾期：历史上进过爆发期，当前离线 r7 ∈ [1.0, 2.0] 且已持续 >= 5 天
争议态：见下（正交标签，可与上述状态叠加）
```

🔧 **V1.1 争议态与情感数据源**

“正负面新闻数量对比”必须先回答 sentiment 从哪来——否则这一格就是全产品唯一“自己编数据却叫数据”的地方。

1. **首选 GDELT GKG 的 `tone` 原生字段**（免费、可复现、不是我方模型产出），按 `tone > 2` / `|tone| <= 2` / `tone < -2` 分正/中/负三档。
2. 若某源无 `tone`（如 Tavily 结果），该源**不参与情感统计**，且 UI 标注“情感仅覆盖 N/M 条信源”。
3. 争议态判据（不是“情感方差大”，而是“信源在价值判断上分裂”）：
   ```
   负向 owner 数 / 总 owner 数 ∈ [0.30, 0.70]  且  n_owners >= 5
   ```
4. 任何自建情感分类器都必须在 UI 标注“情感为模型判定，非事实”，并附抽样人工校验准确率。

### 2.4 生成式 UI 与动态图表

🔧 **V1.1 图表由“受限 DSL”驱动，而非直接生成 ECharts option**

原设计让模型输出完整 ECharts JSON。问题有二：一是成本（单个复合面板 option 数千 token，多图并发生成显著吃延迟与费用）；二是**幻觉的真实形态不止解析失败**——更常见的是语法合法但语义错（绝对值当比率、时间轴倒序、饼图各项加总 ≠ 100、异量纲指标同轴）。原容错只覆盖 `JSON.parse` 失败，覆盖不到以上任何一种。

改为：模型只输出 `ModuleSpec`（zod 强校验 + 枚举白名单），由前端编译器 `compile(spec, dataset) → EChartsOption`。

```ts
type ModuleSpec = {
  id: string;
  kind: "bar" | "line" | "pie" | "treemap" | "map" | "table" | "kpi";
  title: string;
  dataset: string;                               // 只能引用 Analyzer 已产出的具名数据集
  encode: { x?: string; y?: string; series?: string; value?: string; geo?: string };
  note?: string;
};
```

**编译器侧的白名单校验（拒绝而非修正）**：

- `pie`：只允许 1 个 `series`、`value >= 0`、最多 8 个扇区，超出则拒绝并降级 `table`。
- `line/bar`：`x` 必须是时间或序数类型；时间轴强制升序。
- 异量纲检测：`encode.y` 指向的字段单位不一致时拒绝，降级为双图或 `table`。
- 任何拒绝都产出 `module.error` 事件（见附录 A），不静默。

**渐进式渲染**：

- Step 1：摘要 Agent 优先流式输出文本总结（解决等待焦虑）。
- Step 2：图表 Agent 后台并行生成，前端卡片“长出来”一块渲染一块。
- 🔧 协议见**附录 A（SSE 事件契约）**；骨架卡先落位、流式期间禁用拖拽。

### 2.5 模块化工作台与定制

- 前端基于 `react-grid-layout` 实现。
- **交互**：
  - 自由拖拽、缩放图表卡片。
  - **一句话定制**：支持自然语言（如“帮我加一个展示正负面情绪的饼图”），系统从模板库调用或由 AI 现场生成新模块插入面板。
- **布局快照**存入 Supabase，下次搜索恢复。

🔧 **V1.1 补充约束**：

1. 每个卡片必须是**已注册 widget**（`components/modules/registry.ts`），"AI 现场生成"只能生产 `ModuleSpec`，**不能生成新组件代码**。
2. 布局快照带 `schemaVersion`；加载时版本不匹配走迁移或丢弃，不硬渲染。
3. 卡片重排只在 `done` 事件后解锁（详见附录 A）。

---

## 3. 交互与容错设计

- **视觉风格**：极暗黑（Dark Mode）、毛玻璃（Glassmorphism）、高密度数据排版（参考 Palantir / Perplexity），Tailwind CSS 实现。
- **幻觉与报错降级**：AI 生成的图表配置失败时提示“由于 AI 幻觉，当前图表无法生成。您需要重试吗？”；重试仍失败则自动降级为预设结构化表格，确保数据不丢失。

🔧 **V1.1 降级矩阵（每层都必须有兜底，不允许空白区域）**

| 失败点 | 用户可见 | 系统行为 |
|---|---|---|
| Router 失败 | 澄清卡 + 通用检索 | 降级为 `exploratory` 保守模式 |
| 单数据源超时/429 | 该模块标“源不可用” | 其余模块正常渲染 |
| 抽取校验失败 | 原文卡片列表 | 不展示聚合数字 |
| ModuleSpec 校验失败 | “AI 幻觉，图表无法生成”+ 重试 | 降级 `table` |
| 编译器拒绝（语义非法） | 同上 + 原因码 | 降级 `table` |
| 全部模块失败 | 检索结果原文列表 | 保证“至少给出来源” |
| 零结果 | 空态面板（含改写建议） | 见 6.6 |

---

## 4. 技术架构与约束

- **全栈框架**：Next.js（App Router）+ TypeScript。
- **状态与鉴权**：Supabase（PostgreSQL + pgvector）。
- **AI 编排**：**Vercel AI SDK**（`streamText` / `streamObject` / tool calling）。
- **图表渲染**：ECharts + `echarts-for-react`（由 DSL 编译器驱动，见 2.4）。
- **界面布局**：`react-grid-layout`。

🔧 **V1.1 移除 LangChain.js**。AI SDK 与 LangChain 是两套流式抽象，混用会导致“编排状态在一套、输出在另一套”，调试成本远超收益。四个 Agent 本质是一条显式异步流水线 + 状态机：

```ts
route(query)            // → Intent
  → retrieve(intent)    // → RawSource[]（并发 + 单源超时 + 单源失败隔离）
  → analyze(raw)        // → { datasets, confidence, sources }
  → compose(datasets)   // → ModuleSpec[]
```

🔧 **V1.1 目录结构（工程约定）**

```
src/
  app/                    # App Router
    page.tsx              # 搜索首页（暗黑工作台）
    api/search/route.ts   # SSE 流式端点
  agents/                 # 流水线四步，每步纯函数 + zod I/O
    route.ts retrieve.ts analyze.ts compose.ts pipeline.ts
  lib/
    schemas.ts            # Intent / RawSource / Dataset / ModuleSpec / SSE 事件
    confidence.ts         # 三份量置信度
    heat.ts               # 热度公式 + 状态机
    compile.ts            # ModuleSpec → EChartsOption（白名单校验）
    sse.ts                # 事件编码
  components/
    workspace.tsx module-card.tsx confidence-badge.tsx source-list.tsx
    modules/              # 7 种 widget + registry.ts
```

**Agent 流水线**：

| Agent | 职责 | 失败策略 |
|---|---|---|
| Router Agent | 意图判定、实体抽取、歧义评分 | 降级 exploratory |
| Retriever Agent | 多源并发抓取、归一化、语言标记 | 单源隔离 |
| Analyzer Agent | 去重、owner 归并、置信度、数据集构建 | 去重失败则置信度强制 < 0.5 |
| Compose Agent | 产出受限 `ModuleSpec`（**不产出 ECharts option**） | 降级 table |

---

## 附录 A：SSE 事件契约（🔧 V1.1 新增）

渐进式渲染必须是**单一 SSE 连接上的多路事件**（多个 `fetch` 无法保证顺序、无法与文本流对齐）。

```
event: intent         data: { "kind":"exploratory", "ambiguity":0.42, "entities":[...], "timeRange":{...} }

event: text.delta     data: { "delta":"..." }

event: module.plan    data: { "id":"m1", "kind":"line", "title":"90天讨论度", "w":6, "h":8 }
event: module.ready   data: { "id":"m1", "spec":{...}, "dataset":{...}, "sources":["s1","s2"], "confidence":0.72 }
event: module.error   data: { "id":"m1", "reason":"schema_invalid" | "semantic_invalid" | "source_unavailable", "fallback":"table" }

event: done           data: { "confidence":0.72, "independent_sources":6, "degraded":["m3"] }
```

**前端消费规则**：

1. `module.plan` 先落**骨架卡**（固定 id + 预估网格尺寸），`module.ready` 只替换内容 —— 否则流式追加会让 `react-grid-layout` 反复重排，用户正在拖的布局会跳。
2. 流式期间禁用拖拽，`done` 后解锁。
3. `module.error` 必须渲染为可见的降级卡片，不允许静默移除占位。

---

## 附录 B：非功能需求（🔧 V1.1 新增）

| 类别 | 约束 |
|---|---|
| **成本** | 单次搜索 LLM 调用 ≤ 6 次；单次搜索 token 预算 ≤ 40k（含抽取与 Compose）；日预算可配置，超限走缓存或排队 |
| **缓存** | 同一 `query + intent` 的面板结果缓存 TTL = 6h；命中直接回放，不打外部 API；缓存键含 `layoutVersion` |
| **限流** | 单用户 3 次检索 / 分钟；外部源配额：GDELT DOC API ≤ 1 req/5s（实测超额返回 429），Tavily 按套餐并发上限的 70% 使用 |
| **可观测性** | 每一步记录：耗时、token、失败原因、降级次数、独立源数、置信度分布。**没有这些指标，Phase 2 调优只能靠猜** |
| **数据合规** | 只存 metadata + 摘要 + 原文链接，不落库新闻正文；GDELT 结果需署名 |
| **空态** | 冷门词零结果时展示：已尝试的源清单 + 关键词改写建议 + 邻近热词（来自热点榜） |
| **可访问性** | 暗黑主题对比度 ≥ 4.5:1；图表必须有 `aria-label` 与表格降级视图 |

---

## 附录 C：验收标准（🔧 V1.1 新增）

“高置信度”当前没有可判定的标准，补四条可测项：

1. 面板上任意数字，点击 ≤ 2 次可看到原始出处（URL + 原文片段 + 抓取时间）。
2. 无原文支撑的数字，出现率为 **0**（抽样 100 个数字人工核验）。
3. 置信度徽章可展开，且展开后的信源清单与展示数字**一一对应**（数量、owner、一手/转载标记均可核对）。
4. 任一数据源失败时，面板仍能渲染 ≥ 1 个模块，且明确标注缺失项。

---

## 5. 迭代路线图（🔧 V1.1 重排）

### Phase 1（MVP 跑通闭环 — 1 个月）

- 极暗黑风格搜索框 + 工作台外壳。
- 接入单一搜索 API（Tavily）+ 结构化抽取（`generateObject` + zod + 降级）。
- 文本流式输出 + **一张**基础折线图（走 `ModuleSpec` 编译器，不直出 option）。
- 单列卡片流；SSE 事件契约（附录 A）先跑通 `text.delta` / `module.plan` / `module.ready` / `done`。
- **验收**：任意词能出面板；抽不出数据的词降级为原文列表而非空白；每个数字可溯源。

### Phase 2（多源、拖拽、热点榜 v0 — 2 个月）

- 多数据源接入（GDELT / Wikipedia pageviews / HN）+ 单源失败隔离。
- 三分量置信度上线 + 徽章可展开 + 四条硬规则全量落实。
- `react-grid-layout` 拖拽与布局快照（Supabase）。
- “一句话生成模块”（只产出 `ModuleSpec`，走注册表）。
- 🔧 **热点榜 v0**：静态 Top N（按 `articles_24h` 排序即可），**不做状态标签**。
- **验收**：拖拽保存刷新仍在；热点榜有内容且可点进详情。

### Phase 3（热度算法、状态机与实体图 — 3 个月）

- 后台 Cron 热点计算任务：完整热度公式 + 状态阈值表 + 争议态（GDELT tone）。
- 实体关系图：**先用 Postgres 邻接表 + pgvector 做 2 跳查询出树状图**，Neo4j 仅在明确触到性能上限后再评估。
- 可观测性面板（耗时 / token / 降级率 / 置信度分布）。
- **验收**：附录 C 四条全过；热点状态标签与阈值表一致。

> 🔧 重排理由：热度榜是**唯一不依赖用户 query 的回访入口**（也是拉新入口）。原计划放到第 6 个月，意味着前 5 个月产品没有任何打开理由。
