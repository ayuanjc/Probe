# 探针 · Probe

面向 Geek 的 AI 原生高置信度情报终端：搜索返回一个数据面板，而不是一串链接。

**差异化不是"更聪明的分析"，而是"不撒谎"**：页面上的每个数字都能点回原文，
没有来源就不显示，缺失就留空而不是填 0。默认只呈数据，追问才做分析。

---

## 快速开始

```bash
npm install
cp .env.example .env.local   # 可选，不配 key 也能跑
npm run dev                  # http://localhost:3210
```

不配 `OPENAI_API_KEY` 时：检索与图表全部真实，摘要走本地模板，**断言抽取关闭**（不是用假数据填空）。

配了之后可额外得到：

| 变量 | 作用 |
| --- | --- |
| `OPENAI_API_KEY` | 意图精修、断言抽取、流式摘要 |
| `PROBE_MODEL` | 默认 `gpt-4.1-mini` |
| `TAVILY_API_KEY` | 补一路通用搜索，显著提升信源多样性 |
| `PROBE_RATE_LIMIT_PER_MIN` | 单用户每分钟检索上限，默认 3（PRD 附录 B） |

## 四个阶段

```
route    → intent（规则先行，模型精修，模型失败自动回落）
retrieve → 4 路并发检索，逐源隔离，任何一路挂掉只记 degraded
analyze  → 去重 → 置信度 → 断言抽取 → 数据集
compose  → 数据集映射成 ModuleSpec，过 compile() 白名单校验
```

前端通过 SSE 收 `intent / text.delta / module.plan / module.ready / module.error / sources / done`，
`module.plan` 先落骨架卡、`module.ready` 再换内容，所以不会盯着空白等。

## 置信度：为什么不用"多信源收敛度"

收敛度高只能证明各家的说法一致——十家媒体转载同一篇通稿即可满分，那是假共识。
这里改成三个可测量的分量：

```
score = 0.40 × 一手性 + 0.35 × 独立性 + 0.25 × 一致性
一手性 P = 1 - 转载数 / 总数
独立性 I = 1 - e^(-独立稿源数 / 3)      // 3 家 0.63，6 家 0.86，之后饱和
一致性 C = 1 - 冲突数 / 可比对数         // 无可比断言时取中性 0.5，不是 1
```

一致性按 `attr + unit` 分组：只按 attr 分组时，"营收 $3.2B" 与 "营收 3.2 million"
都会被归一成 `3.2`，三个数量级的差距被判为"完全一致"。单位不同即不同组，
组内不足两条就不参与比对。

分档 ≥0.75 高、0.50–0.75 中、<0.50 低；**低档直接抑制聚合数字与分布图**，只留原文列表。

三条硬约束写死在代码里：

1. 独立稿源 < 2 时封顶 0.45。
2. 整批都是本地演示样本时封顶 0.34，并在正文里明说"这不是实时抓取的结果"；样本不进模型，
   由代码写死的事实说明替代——只靠 prompt 叮嘱"记得说这不是实时结果"是不可靠的。
3. 没有模型时断言数为空——**不用模板编造 claim**，否则界面上会出现几句谁也没说过的"可核验断言"。
4. **一条断言都没交叉核对过（`nChecked === 0`）时封顶 0.74。**
   一致性给中性 0.5、乘 0.25 权重后，只要一手性和独立性接近满分就会越过 0.75——
   可那个分数里没有任何一条事实被两个来源对上过。独立性靠域名数量堆得动，
   一手性靠"没识别出转载"就能满分，只有一致性真正代表"核验过"。

`ownerOf` 的口径必须全链路一致（`confidence.ts` 与 `analyze.ts` 同源），
否则 KPI 的"独立信源"数和信源分布柱的分组数会对不上。二级公共后缀要单独成表，
`bbc.co.uk` / `ft.co.uk` 若按 `slice(-2)` 切成 `co.uk`，十几家无关英国媒体会被并成一个稿源。

## 时间窗必须真过滤

用户的"最近三个月"是显式约束。每个 provider 都在服务端带窗口参数
（GDELT `startdatetime`、HN Algolia `numericFilters=created_at_i`、Tavily `start_date`），
返回后本地再兜一层。宁可结果稀疏，也不拿六年前的旧闻凑数量。

## 热点榜：一个只能搜索的产品没有回访理由

无 query 时首屏给热榜，数据来自 Hacker News 近 24 小时的 story 聚合（`src/lib/trending.ts`）：

- 抓过去 24 小时全部 story（实测约 994 条），只保留 `points >= 2` 的 553 条。
  另外 442 条 points 为 0 —— 全是刚发布、无人评分的，把它们算进"提及数"等于让冷门词冒充热点。
- 按词边界匹配实体词典，同一个话题被 **两条以上** 提到才上榜（一条不足以叫热点，只能叫新闻）。
- **按提及条数排序，不按 points 之和**：三条爆款（TLS，1068 分）会盖过十三家在提的实体
  （谷歌，411 分），那不是热度，是单篇运气。
- 缓存 10 分钟；话题名与检索词分开（展示 `人工智能`，检索 `artificial intelligence`），
  否则中文话题丢进英文索引必然 0 命中。

榜单标题写死「Hacker News 前沿」而不是「实时热点」：GDELT 缺席时这里只有单一来源，
「多少家媒体在报」这个维度并不存在，写成全网热度就是编。

顺带修了一个连带缺陷：`kindOf` 原来按 `length < 5` 判 "需要澄清"，于是 `英伟达`、`人工智能`、
`Rust` 这类主体明确的短查询全被判死，热榜点进来每一张卡都会撞墙。含糊不等于短 ——
现在只拦真正的寒暄（`你好` / `hi` / `test`）。

## 目录

```
src/
  agents/     route · retrieve · analyze · compose · pipeline
  lib/        schemas · confidence · heat · compile · sse · llm · fixtures · entities · text · trending
  app/        layout · page · globals.css · api/search/route.ts
  components/ Workspace · SearchBar · ModuleCard · ConfidenceBadge · SourceList · TrendingBoard
  hooks/      useProbe.ts
```

`src/lib/compile.ts` 是图表的安全边界：模型只能产出受限 `ModuleSpec`，
ECharts option 由前端编译器按白名单生成。让模型直出 option 的失败方式不是语法错，
而是"语法合法、语义胡说"——那种错没有人能一眼看出来。

## 数据源实测

| 源 | 状态 | 说明 |
| --- | --- | --- |
| Hacker News (Algolia) | ✅ 可用 | **发现层**：每条 story 指向各自原站，owner 从真实域名取，否则独立性永远是 1 |
| Wikipedia pageviews | ✅ 可用 | 单条目，做热度旁证 |
| GDELT DOC 2.0 | ⚠️ 长期 429 | 按 IP 限流 1 req/5s，超限时拖 12–14 秒才回纯文本。2.5s 软超时 + 300s 冷却 |
| Tavily | 🔑 需 key | 未配置时静默跳过，不算降级 |
| Google News RSS / Bing News RSS | ❌ 不可达 | 本机网络环境下连接超时 |

## 已知限制

- **HN 不是新闻媒体**：它是聚合入口，返回的条目里含博客、GitHub、个人站。
  信源多样性是真实的，但"媒体机构"这个语义不成立。
- **GDELT 长期被限流**：这台机器的出口 IP 基本拿不到数据，实时面板实际上只由
  HN + Wiki 支撑；同一 IP 短时间反复查同一实体，结果会高度重合。
- **没有向量检索与缓存**：Phase 1 每次查询都重新抓取，TTL 缓存留给下一阶段。
- **单用户假设**：限流与预算按进程内变量计，多实例部署会失效。
- **限流会拦到你**：默认 3 次/分钟。本地反复调试时用 `PROBE_RATE_LIMIT_PER_MIN=50` 启动。
- **GDELT 冷却只对限流与超时生效**：一条查询语法写错不该让后面所有查询一起停摆 5 分钟。
- **热榜是单源**：只有 Hacker News，它偏技术圈；GDELT 恢复后「多少家媒体在报」才成立。
  `heat.ts` 里的完整热度公式（median_30d / MAD_30d / 状态机）依赖历史累积，Phase 3 才接线。

## 验收口径（对应 PRD 附录 C）

- 数字点击 ≤ 2 次到原文 ✅ 每个模块头部有「溯源 N 条」抽屉（列出该模块实际引用的条目，
  不是全量信源），`SourceList` 另有全量直链
- 无源数字出现率 0 ✅ 低置信档禁止聚合数字；KPI 只数已抓到的条目
- 徽章可展开且与数字一一对应 ✅ `ConfidenceBadge` 用 `<details>` 展开三分量
- 单源失败仍渲染 ≥ 1 模块 ✅ 四路 `Promise.allSettled` 隔离 + 全空落样本

```bash
npm run typecheck   # tsc --noEmit
npm run build
```
