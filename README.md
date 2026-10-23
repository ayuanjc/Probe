# 探针 · Probe

**搜索即生成数据面板的情报终端 —— 每个数字都能点回它的原文出处。**

> Geek-oriented, AI-native intelligence terminal: search returns a dashboard, not a link list.

---

## 状态

| 项 | 值 |
|---|---|
| 阶段 | 设计定稿 + 工程脚手架（Phase 1 未开工） |
| 现行 PRD | [V1.1](docs/PRD.md) |
| 代码 | Phase 1 垂直切片已跑通：意图路由 → 多源检索（GDELT / HN / Wikipedia / Tavily）→ 分析（去重、owner 归并、三分量置信度）→ `ModuleSpec` 编译器 → SSE 工作台。未接 Supabase，布局不持久化 |
| 许可 | 待定（未选定许可证前按保留所有权利处理） |

## 它是什么

传统搜索返回十条链接；探针返回一块**可交互的数据面板**：KPI 卡片、趋势折线、地域分布、信源列表，由意图路由 + 多 Agent 流水线实时生成（Generative UI）。

三条差异化：

1. **高置信度** —— 不编造事实。每个数字背后是「哪些独立信源、互相印证到什么程度」，而不是一句"AI 认为"。
2. **生成式 UI** —— 搜索即生成仪表盘，而不是返回死板网页。
3. **克制分析** —— 默认只给高密度数据与图表；要解读，用户主动追问。

### 边界（写死，不可协商）

> 本产品**不做事实裁决，只做来源透明度**。输出的是"这些数字来自哪些独立信源、印证到什么程度"，不是"这是真的"。

四条硬规则：

1. **可溯源**：任意数字 ≤ 2 次点击看到原文出处（URL + 片段 + 抓取时间）。
2. **无源不显示**：抽不出原文支撑的数字不显示，绝不显示为 0。
3. **缺失不填 0**：缺失显示"数据缺失 / 该源不可用"，不写"暂无数据"。
4. **徽章可展开**：置信度徽章展开即信源清单（owner、一手/转载标记、各分量值）。不可展开 = 未实现。

## 核心算法

**置信度**（三分量加权，替代"信源收敛度"——后者会奖励转载抄袭，即假共识）：

| 分量 | 含义 | 权重 |
|---|---|---|
| 一手性 P | 一手发布 vs 转载（canonical 相同 / 标题相似 > 0.90 / 晚于首条 > 6h 且内容重合 > 0.8 判转载） | 0.40 |
| 独立性 I | 域名归并为 owner 后的互不隶属信源数，`I = 1 - exp(-n_owners/3)` | 0.35 |
| 一致性 C | 去重后独立源在 (实体, 数值, 时间) 上的吻合度 | 0.25 |

`confidence = 0.40P + 0.35I + 0.25C`；`n_owners < 2` 时强制 `min(confidence, 0.45)`。
分档：**≥0.75 高**（绿，数字正常展示）／**0.50–0.75 中**（琥珀，标"待印证"）／**<0.50 低**（灰，只展示原文列表，不展示聚合数字）。

**热度**（同量纲 + 整体衰减，替代量纲不可加的旧式）：

```
Mag   = log1p(articles_24h)
Dev   = (articles_24h - median_30d) / (MAD_30d + 1e-6)
raw   = 0.6 * pct90(Mag) + 0.4 * pct90(Dev)
score = raw * exp(-age_hours / 36)
```

状态阈值：`r7 = 近 7 日均值 / 前 30 日均值` → `>2.0` 且 90 天 Top 5% 为**爆发期**；`1.3–2.0` 升温期；`0.8–1.3` 平稳期；`<0.8` 回落期。**争议态**为正交标签：负向 owner 占比 0.30–0.70 且 `n_owners >= 5`，情感取 GDELT GKG 原生 `tone` 字段，不自建分类器。

## 文档地图

| 文档 | 内容 |
|---|---|
| [docs/PRD.md](docs/PRD.md) | 产品需求文档 **V1.1（现行）**：意图澄清卡、三分量置信度、热度公式、受限图表 DSL、SSE 契约、降级矩阵、非功能需求、验收标准 |
| [docs/PRD-评审建议.md](docs/PRD-评审建议.md) | 对 V1.0 的工程/产品评审：四条致命问题与可直接落地的改法 |
| [docs/可行性分析.md](docs/可行性分析.md) | 数据源实测、开源选型（A 档可直接用 / B 档组件）、参考架构、成本与硬风险 |
| [docs/PRD-v1.0.md](docs/PRD-v1.0.md) | V1.0 原始需求存档（不增删需求） |

## 技术栈

| 层 | 选型 |
|---|---|
| 框架 | Next.js 16（App Router）+ React 19 + TypeScript |
| 样式 | Tailwind CSS 4 |
| AI 编排 | Vercel AI SDK 7（`streamText` / `streamObject`），**不使用 LangChain** |
| 校验 | zod 4（Agent 每步 I/O 强校验） |
| 图表 | ECharts 6 + echarts-for-react，由受限 DSL 编译；模型不直出 option |
| 布局 | react-grid-layout |
| 存储 | Supabase（Postgres + pgvector），Phase 2 起接入 |

流水线（每步纯函数 + zod I/O）：

```
route(query)     → Intent
  → retrieve(intent)  → RawSource[]        // 多源并发，单源超时 6s，失败隔离
  → analyze(raw)      → { datasets, confidence, sources }
  → compose(datasets) → ModuleSpec[]       // 受限 DSL，不产出 ECharts option
```

## 目录结构

```
src/
  app/
    page.tsx              # 搜索首页 → 工作台外壳
    layout.tsx globals.css
    api/search/route.ts   # SSE 端点：单连接多路事件（附录 A 契约）
  agents/                 # 四步流水线，每步纯函数 + zod I/O
    route.ts retrieve.ts analyze.ts compose.ts pipeline.ts
  lib/
    schemas.ts            # Intent / RawSource / Dataset / ModuleSpec / SSE 事件
    confidence.ts heat.ts # 三分量置信度 / 热度公式与状态机
    compile.ts            # ModuleSpec → EChartsOption（白名单校验，拒绝而非修正）
    sse.ts entities.ts llm.ts text.ts fixtures.ts
  components/             # Workspace / ModuleCard / ConfidenceBadge / SourceList / SearchBar
  hooks/useProbe.ts       # SSE 消费 + 渐进式渲染状态
```

## 数据源（已实测，不是纸面推测）

| 源 | 状态 | 限制 |
|---|---|---|
| GDELT DOC 2.0 API | ✅ 200，无 key | **1 req / 5s**，超限直接 429 |
| GDELT v2 15 分钟增量 | ✅ | 约 474 MB/天（压缩）；GEO 2.0 端点已 404，地图用 `export.CSV` 的 ActionGeo 自聚合 |
| Wikipedia pageviews | ✅ 逐月时序 | — |
| HN Algolia | ✅ | — |
| BBC / 通用 RSS | ✅ | — |
| Reddit 直连 | ❌ 需 OAuth | — |
| 微博热搜 | ❌ 403 | 中文社媒层需自建采集 + 代理池，属持续运维成本 |

## 路线图

**Phase 1 · MVP 闭环（1 个月）**
暗黑搜索框 + 工作台外壳；Tavily 单源 + `generateObject` 结构化抽取（校验失败降级原文列表，不留空白面板）；文本流式 + 一张折线图（走 `ModuleSpec` 编译器）；单列卡片流；SSE 契约先跑通 `text.delta` / `module.plan` / `module.ready` / `done`。
**验收**：任意词能出面板；抽不出数据的词降级为原文列表而非空白；每个数字可溯源。

**Phase 2 · 多源 / 拖拽 / 热点榜 v0（2 个月）**
GDELT + Wikipedia + HN 接入与单源失败隔离；三分量置信度上线 + 徽章可展开 + 四条硬规则全量落实；`react-grid-layout` 拖拽与布局快照；"一句话生成模块"（只产出 `ModuleSpec`）；热点榜 v0（静态 Top N，不做状态标签）。

**Phase 3 · 热度算法 / 状态机 / 实体图（3 个月）**
Cron 热度计算 + 状态阈值表 + 争议态；实体图先用 Postgres 邻接表 + pgvector 做两跳查询，Neo4j 仅触到性能上限后再评估；可观测性面板（耗时 / token / 降级率 / 置信度分布）。

## 快速开始

```bash
npm install
cp .env.example .env.local   # 不填任何 key 也能跑：流水线回退到确定性 fixture provider
npm run dev                  # http://localhost:3000
npm run typecheck
```

## 仓库约定

- **分支**：`main` 即发布线；改动小步提交，一个提交只做一件事。
- **提交信息**：`feat:` / `fix:` / `docs:` / `chore:` + 一句话中文描述。
- **文档先行**：PRD 正文改动必须同步更新文档内「0. 变更记录」表并升版本号（V1.1 → V1.2）。
- **文档与实现不一致**：先改文档再改代码，分歧记进 PRD 附录，不靠口口相传。
- **合规线**：只存 metadata + 摘要 + 原文链接，不落库新闻正文；GDELT 结果需署名。
