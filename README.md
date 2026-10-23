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
- 同一话题内按 **URL 去重**：HN 上同一篇稿子被重复提交是常态（多条 story、不同 objectID、
  外链一模一样）。不收敛的后果是列表里同一链接出现两次（React 列表 key 冲突）加上
  「N 条在提」把同一篇稿子数两遍 —— 那是提交次数，不是报道数。去重保留 points 最高的那条，
  去重后不足两条的话题不上榜。
- 缓存 10 分钟；话题名与检索词分开（展示 `人工智能`，检索 `artificial intelligence`），
  否则中文话题丢进英文索引必然 0 命中。

榜单标题写死「Hacker News 前沿」而不是「实时热点」：GDELT 缺席时这里只有单一来源，
「多少家媒体在报」这个维度并不存在，写成全网热度就是编。

顺带修了一个连带缺陷：`kindOf` 原来按 `length < 5` 判 "需要澄清"，于是 `英伟达`、`人工智能`、
`Rust` 这类主体明确的短查询全被判死，热榜点进来每一张卡都会撞墙。含糊不等于短 ——
现在只拦真正的寒暄（`你好` / `hi` / `test`）。

## 拖拽布局：快照为什么先落在本机

Phase 2 的验收是「拖拽保存刷新仍在」。PRD 写的是 Supabase，但那个 key 至今空着——
没有鉴权、没有表结构，写进去只能先造一张谁都能读的表。所以这一版把快照存在
`localStorage`，键是 `probe:layout:<layoutVersion>:<query>`，**结构仍按 PRD**：

```
{ schemaVersion, layoutVersion, query, savedAt, items: [{ i, x, y, w, h }] }
```

换存储层只改 `src/lib/layout.ts` 的读写，形状不变；界面文案如实写着"按查询词存在本机"。

几个不显眼但会咬人的点：

- **流式期间锁拖拽**，不是靠 CSS 假装。`module.plan` 一路到达就重排一次，
  用户在拖到一半的卡片会跳走；锁是真的把 `dragConfig.enabled` 关掉，且不渲染拖拽把手。
- **只在 `onDragStop` / `onResizeStop` 提交**。跟 `onLayoutChange` 提交的区别不是性能洁癖：
  每帧 setState 会重渲染整棵树，ECharts 实例跟着重建，拖起来像在拖一张图片。
- **快照不复活已消失的卡片**。`reconcile` 以本轮默认布局为准，只把能对上的 id 的位置搬过来；
  上一轮有的模块这一轮没有，就直接不出现，不硬渲染一个没有数据的空壳。
- **版本不匹配整份丢弃**并给一句中文提示，而不是逐项迁移——布局数据不值钱，
  读错的布局会让人以为卡片丢了。
- **卡片高度交给网格单元**（行高 28、间距 12），图表容器 `height:100%`：
  拖高卡片图跟着长，拖矮则保住 `min-h` 不压成一条缝。
- **窗口 < 720px 退回单列**并说明拖拽已停用。12 列在这个宽度下每列不到 40px，
  拖出来的位置没有任何意义。

## 术语解释：把"行话"摊开在鼠标下面

「一手性」「独立性」「歧义」这些词是产品的核心口径，也是用户最容易误读的地方——
把「置信度 0.74」看成「74% 正确」的人不止一个。所以每个术语都是一个可展开的
`Term`（`src/components/Glossary.tsx`，词条在 `src/lib/glossary.ts`）：

- **三通道打开**：hover（鼠标）、focus（Tab 到）、点击（触屏）。只做 hover 等于
  把触屏和平板用户挡在外面。
- **不用原生 `title`**：原生提示延迟一秒、不可选中、不能换行，塞不下"公式 + 口径 + 已知盲点"三段。
- **弹层用 `createPortal` 挂到 `document.body`，`position: fixed`**。挂在触发词里面会被
  卡片的 `overflow: hidden` 裁掉；网格卡片还带 `transform`，而 `transform` 会把
  `position: fixed` 的包含块从视口改成卡片本身——气泡于是又飞出去、又被裁。挂到 body 才同时躲开这两条。
- **位置是量出来的，不是按 align 猜的**：`getBoundingClientRect()` 取锚点、`offsetWidth/offsetHeight`
  取气泡，先按 `align` 算出一侧，再夹进 `[8, 视口宽 − 8 − 气泡宽]`；下方放不下翻到上方，
  上方也放不下就贴底。缩放、滚动时跟着重算，锚点滚出视口直接关掉。
  只按 `align` 选左右等于赌「这个词永远不在屏幕边上」——页头右侧的置信度徽章专门证伪这一点。
- **从触发词移进气泡不会关**：140ms 延迟关闭 + 气泡自己 `onMouseEnter` 取消。
  否则鼠标一离开词条气泡就消失，"公式 + 口径 + 盲点"三段文案根本读不完。
- `role="tooltip"` + 内层 `aria-label`，Escape 与点外部关闭。
- 词条正文写清**它不是什么**（"置信度是证据强度，不是正确概率"），比只写定义有用。

## 双语对照：颜色标的是"可核对的差异"，不是翻译质量

点任一条信源的「对照原文」，服务端抓正文、分段、翻译，逐段左边原文右边译文
（`src/lib/translate.ts` + `src/components/BilingualCompare.tsx`）。

**歧义度由机械比对算出来，不问模型。** 让模型给自己的译文打分歧分，它永远给 0.9——
那是自评，不是证据。实际用的是可核对、可复现的五类信号：

| 信号 | 触发条件 |
| --- | --- |
| 数字丢失 | 原文里的数字在译文里找不到（正则排除 `Q3` / `H200` 这类编号里的数字） |
| 专名未保留 | 公司/产品/人名被意译掉，读者搜不到原始出处 |
| 未译残留 | 译文里还留着成串英文（单句首大写词如 `Rust` 不算——那本来就该保留） |
| 篇幅比例异常 | 英译中落在 0.22–1.05 之外，通常意味着漏译或自我发挥 |
| 原文本身含糊 | may / could / 据称 / 消息源模糊 —— 翻得再准，读者也会读成确定结论 |

`risk = 1 - Π(1 - w)`，分档 <0.30 低（青）、<0.60 中（琥珀）、否则高（玫红）。
图例里写死了"不是质量评分"：青色只代表数字和专名都对得上，不代表这段话可信。

几条必须守住的边界：

- **内网地址不抓**（localhost / `.local` / `10.` / `192.168.` / `172.16-31` / `169.254.`）——
  这个接口是"让服务器替我访问任意 URL"，不收口就是 SSRF 跳板。
- **抓不到正文就退回标题与片段**，并在面板里写明"只对照了标题与片段"，
  而不是默默拿标题当全文翻。
- **原文本来就是中文时不翻**（`targetFor` 恒为 `zh`）：把中文报告"翻译"成英文
  对读中文的人没有价值，只会多一层机器改写，于是单栏出原文、不给颜色。
- **没译成不记 0 分**：0 分在界面上等于"没问题"，而这一段恰恰最该被怀疑。
- 引擎分级写清楚：有 `OPENAI_API_KEY` 走模型，否则用 MyMemory 公共接口，
  都不行就只给原文分段。面板里永远标注**谁翻的**。
- 公共接口有每日配额，长文只翻得成前一部分（实测 41 段里翻成 20 段）：
  剩下的如实标成"未翻成，保留原文"，并在降级条里写 X/Y。

**一个非写不可的坑**：本机 `NODE_USE_ENV_PROXY=1` 时，Node 的 `fetch` 会走
`HTTPS_PROXY`，而那条链路对 `api.mymemory.translated.net` 会 `ECONNRESET`
（实测 6/6 失败；同一 URL 直连 100% 成功，curl 走代理也正常）。所以抓正文与调翻译
都不走 `fetch`，改用 `node:https` 的 `getDirect`（`src/lib/http.ts`）——
它默认不读代理环境变量。附带好处是重定向、超时、字节上限都握在自己手里。

## 数据模块：不是"多画几种图"，是"多几种能算准的形状"

第二批 6 种图形全部由 `analyze()` 里真算出来的 dataset 驱动，没有一种是装饰性占位。
共同原则：**凑不出就整张图不出**——不画空图，也不补 0。

| 模块 | 形状 | 数据从哪来 | 出不来的时候 |
| --- | --- | --- | --- |
| `m-hours` | heatmap 星期×小时 | `hourParts()` 拆 `publishedAt`（Asia/Hong_Kong；`hour12:false` 下午夜给 24，要再 `%24`） | 只有 1 个格子时不出 |
| `m-weekday` | radar 7 维 | 同一份解析结果按星期计数 | 有数据不满 3 个星期时不出（三维以下没有形状可言） |
| `m-terms` | graph 共现网络 | `titleTerms()` 抽标题里的专名，两两共现计数 | 高频专名 <4 个或边 <3 条时不出：几根散线不叫网络 |
| `m-flow` | funnel 检索收敛 | 命中条目 → 去重后 → 有发布时间 → 24h 内 | 一条都没有发布时间时整张不出 |
| `m-fresh` | gauge 24h 新鲜度 | `fresh / dated` | 同上 |
| `m-tone-scatter` | scatter 时距×情感 | GDELT 的 tone 与距今天数（0–7 天） | 不足 3 个点、或本轮没有 tone 时不出 |

漏斗那四级是刻意选的：`fresh ⊆ dated ⊆ sources ⊆ raw` 是集合包含关系，
所以这张图**不可能自相矛盾**。断言数没有放进来——claim 可以来自没有发布时间的条目，
放进去会破坏包含关系，画出来就会出现"后一级比前一级多"。

`compile.ts` 的字段校验这批改成了**全量**：以前只查 x/y/value/series 四个键，
graph 的 `from/to` 与 funnel 的 `stage` 正好绕过去，字段写错的结果是一块空白而不是报错。
现在 encode 里任何值不在 fields 中就直接降级成表格，并在卡片上写原因。

## 设置：自己的 key、外观、一键还原

三件事共用一个面板，全部只在本机：

| | 存在哪 | 走哪条路 |
| --- | --- | --- |
| OpenAI / Tavily key、模型名 | `localStorage` 的 `probe:settings:v1` | 每个请求带 `x-probe-openai-key` / `x-probe-tavily-key` / `x-probe-model` |
| 主题、字号、密度、动画、背景网格 | 同上 | 写到 `<html>` 的 `data-theme` / `data-density` / `data-anim` / `data-fx` |
| 布局快照 | `probe:layout:*` | 见上一章 |

key 走请求头而不是查询串：查询串会进服务端访问日志，也会留在浏览器历史里。
服务端用 `AsyncLocalStorage` 把它绑在**本次请求**的调用链上（`src/lib/runtime-config.ts`），
`llmEnabled()` / `resolvedModelId()` / `resolvedTavilyKey()` 都是"先读这次请求的、再回落 env"。
这样不用给每个函数加参数，也不会串到下一个请求里：**不落库、不写日志、不跨请求复用**。

填了错的 key 会怎样：`llmEnabled()` 变 true，模型调用失败，摘要一句都写不出来。
这种情况会在摘要区明说"摘要没有生成"，而不是留一片空白让人以为数据不全——
面板里的数字与信源不依赖模型，照常可读。

主题不是换一套 CSS，而是覆盖 Tailwind v4 的 `--color-cyan-*` 变量：utility 读的就是这些变量，
所以 `text-cyan-400`、`bg-cyan-500/10`、`border-cyan-500/40` 会一起变色，不必去几十个组件里找类名。
**但图表不会跟着变**——ECharts 的调色板写在 `compile.ts` 里，canvas 读不到 CSS 变量，面板里照实写了这句。

字号改的是根字号（15/16/17px）：Tailwind 的间距与字号都是 rem，改根字号等于整站等比缩放。
密度改的是网格间距（紧凑 16 / 标准 24），不是给卡片加一层更小的 padding——
后者会让图表在窄卡里挤成一团。

"一键还原"清掉所有 `probe:` 前缀的本机键（设置 + 每个查询词的布局快照），然后整页重载。
按钮要按两次，第二次 4 秒内有效：这个操作没有撤销。

## 性能：帧率按「最长的那一帧」算，不按平均值

平均值骗人。240Hz 屏上一秒 240 帧，只要有 3 帧掉了 60ms，手感就是「卡一下」，而平均帧率仍然是 230fps。所以这里的验收口径是 **LoAF（long-animation-frame）**：浏览器原生告诉你「这一帧超过 50ms 了吗、渲染开始得多晚、里面脚本占多少」。

测量方式（`PerformanceObserver({ type: "long-animation-frame" })` + rAF 帧间隔采样），1440×1000、`next start` 生产构建、每档跑 3 次看区间：

| 场景 | 改前 最长帧 (ms) | 改后 最长帧 (ms) | 说明 |
| --- | --- | --- | --- |
| 流式输出期间 | 413 / 262 / 229 | 246 / 229 / 213 | 中位 262 → 229（−13%）。**单次测量本身就能差 ±80ms**，所以只敢说中位，不敢说峰值 |
| 流式 jank 帧（>33.4ms） | 5 / 6 / 6 | 5 / 5 / 6 | 每 2000 帧里 5 帧，0.3%，没变 |
| 空闲 | 8.3 / **62.5** / 4.4 | 8.4 / **62.3** / 8.4 | 那 62ms 是偶发的，改前改后都会撞上一次 |
| 滚动 | 16.7 / 8.4 / 12.6 | 8.4 / 8.3 / 8.5 | 三次都一样：首次滚动不再掉一帧 |
| 拖拽 | 50.1 / 45.9 / 66.6 | 45.8 / 74.7 / 62.4 | **没有实质改善**，见下 |

真正稳定的改善是**滚动**：三次测量全部 8.3–8.5ms（= 120Hz 的一帧，本机屏 240Hz 所以是四分之一帧），改前有一半的跑法会掉到 12–17ms。空闲与拖拽的帧率都在 200fps 以上。拖拽没变好：`react-grid-layout` 拖动时是 transform 位移，本来就该是合成层的事，但每次松手前它都要测一遍所有卡片的占位——这段成本它的 API 不给钩子，我们改不动。

流式那 5 个 jank 帧也别指望消掉：那是 8.6 秒里 SSE 事件把三张卡依次塞进网格造成的，属于「内容真的变多了」，不是渲染浪费。

### 具体做了什么

1. **流式合帧**（`src/hooks/useProbe.ts`）：原来每个 `text.delta` 都 `setState`，摘要每多一个字，整棵树（四张卡、两张图）就重渲染一次。现在攒进 ref、按 `requestAnimationFrame` 一帧只刷一次，并且遇到 `module.ready` / `done` 这类结构事件先强制 flush，保证顺序不乱。
2. **ECharts 动画 1000ms → 240ms**（`src/lib/compile.ts`）：默认入场动画会在这 1 秒里每帧重绘 canvas；情报工具不需要「图表长出来」的仪式感。
3. **`backdrop-filter` 查了一遍，最后留着**（`src/app/globals.css` 的 `.panel`）：一度以为「十几张卡各带一层 `blur(24px)`」是滚动掉帧的元凶，就去掉了。随后做 A/B（运行时注入/撤掉 `.panel` 的 blur，首页 12 张卡）——**去掉 blur 之后滚动 231fps、最长帧 8.4ms；带着 blur 是 234fps、最长帧还是 8.4ms**，4 倍 CPU 降频下也一样。之后又只针对流式段做了 A/B（页面启动前注入 `backdrop-filter: none`）：带 blur 最长帧 112.3–112.6ms，去掉是 104–108ms，差 4–8ms——有成本，但落在噪声里。原因大概是卡片背后只有一层静态渐变，Chrome 把这层采样缓存住了。所以这是冤枉的，blur 恢复（它是这套界面的一部分）。真正留下的是 `contain: layout style`——让卡片内部布局不外溢，拖拽时少一次全局布局计算。
4. **hover 光晕改成常驻层 + 改透明度**：原来是把 `box-shadow` 从无过渡到一片大范围模糊阴影，指针扫过一排卡片时每张卡都要重新光栅化；现在阴影在一次绘制里、之后只切 `opacity`，非 hover 状态干脆 `visibility: hidden`（连绘制准备都跳过）。
5. **背景渐变搬进 fixed 伪元素**：写在 `body` 上的 `background-image`，即使加了 `background-attachment: fixed`，滚动时浏览器仍会重绘整块视口背景。现在是两层固定的合成层（`body::before` 辉光 + 扫描线、`body::after` 网格 + mask），滚动只移动内容层。
6. **`ResizeObserver` 让 canvas 跟着卡片走**（`ModuleCard` 里的 `ChartBox`）：ECharts 只知道窗口尺寸，不知道卡片被拖大了——原来把卡从 4×8 拖到 6×11，图会被拉花。现在按帧去抖后 `resize()`。
7. **拖拽期间降级**（`ModuleGrid` 在 `<body>` 上挂 `.grid-interacting`）：过渡、发丝光、外发光全关掉，只剩移动一个已光栅化的图层，松手恢复。
8. **`memo` 挡在网格外**（`ModuleGrid` / `ModuleCard` / `SourceList`）：流式期间摘要每帧变，但 `modules` / `sources` 的引用没变，网格不必跟着重跑 `react-grid-layout` 的布局计算。
9. **尊重 `prefers-reduced-motion`**：关掉光标闪烁与骨架流动。这不是性能，是礼貌。

### 一个必须说清的坑

`npm run dev` 下的数字**不能**用来判断渲染性能。Turbopack 的按需编译、React 开发版的双次渲染，都会在首次交互时塞进几百毫秒的长任务；同一个页面在 `next start` 下这些数字会凭空少一半。要复现上表，先 `npm run build` 再 `npm start`，且不要和 `next dev` 同时跑（两者共用 `.next`）。

## 一句话生成模块：句子只决定「看哪份数据、用哪种图形」

输入「用散点图看情感分布」，网格里多一张卡。这句话里的模型能决定的只有三件事：
**用哪一份数据集、画哪种图、标题叫什么**。字段怎么映射到 x / y / value 不归它管——
`compile.ts` 是安全边界，模型直出的 encode 的失败方式不是语法错，而是「语法合法、语义胡说」，
那种错没有人能一眼看出来。所以 `autoEncode()` 按字段类型硬性匹配：数值字段才配 value 轴，
时间字段优先配 x 轴，一张都匹配不上就返回 null，让调用方换图。

没有 key 的时候走 `src/lib/module-plan.ts` 的本机关键词规则，两个细节是有意的：

- `KIND_WORDS` 的**顺序**参与语义：「散点图」必须排在「图」前面，否则任何带「图」的句子都会退化成长条。
- `DS_WORDS` 给每份数据集配中文说法（信源/稿源/来源、时段/小时/几点、星期/周几/周末……），
  按 `命中词 × 3 + 数据集名字串 × 4 + 字段名 × 1` 打分。**一个都没命中时不猜**，
  直接回一份「这一轮有这些数据」的清单让人自己挑。

数据只从**这一轮已经算出来的** dataset 里挑（`datasetsFromModules` 遍历现有模块的 `spec.dataset`），
不重新检索、不碰全网。代价是自定义面板跟着这一轮走：刷新页面或换一个问题，它就没了——
这句话直接印在面板上，不让人误以为它被存下来了。

生成器放在结果区**右侧的 sticky 栏**（≥1280px 两列，更窄时落到结果下面）。按 `xl` 而不是
`lg` 分栏是有原因的：1024–1279px 撑两列，左列会窄过 `ModuleGrid` 的 720px 底线，
网格直接退回单列——那不如让它先不分栏。检索过程中侧栏也一直在（只是显示"done 之后可用"），
避免 idle → running 时整页宽度跳一下。

画不出来时说清楚。前端先拿 `compile()` 试一遍，失败就把 `compileErrorText` 的原话贴出来
（「雷达图至少要三个维度」），**不悄悄降级成表格**——一张表能装下任何数据，但用户要的是图，
换成表格等于没回答。字段真的不合适时，规则会在**选图阶段**就换一种（「用散点图看信源分布」
只有一列数值，改条形图），并在 reason 里写「已改用条形图」。

一个坑记在这：`compile()` 对 `table` / `kpi` 返回 `unknown_kind`（它是给图表用的），
所以这两种图在插入前跳过编译，否则「用指标卡看概况」永远失败。

实测（`POST /api/module`，无 key，本机规则路径）：

| 句子 | 结果 |
| --- | --- |
| 用条形图看每天的文章数 | `bar` + `ds-timeline`，encode `{x: day, y: articles}` |
| 看发布时段 | `heatmap` + `ds-hours`，encode `{x: weekday, y: hour, value: articles}` |
| 用散点图看趋势 | 回落 `line`，reason 写「按日文章数」的字段画不出散点图 |
| 用散点图看信源分布 | 回落 `bar`，同一条路径的第二层兜底 |
| 你好 | `{ok: false, error: "no_dataset"}`，附这一轮可用数据集清单 |

路由限流 12 次/分钟（`PROBE_MODULE_RATE_LIMIT_PER_MIN`），和搜索分开计数：
本机规则是廉价调用，但走到模型路径要花钱，别让它变成无限次试用。
## 目录

```
src/
  agents/     route · retrieve · analyze · compose · pipeline
  lib/        schemas · confidence · heat · compile · layout · module-catalog · module-plan · sse · llm
              fixtures · entities · text · trending · glossary · lang · translate · translate-risk
              translate-types · http · settings · runtime-config · config-headers
  app/        layout · page · globals.css · api/search/route.ts · api/translate/route.ts · api/module/route.ts
  components/ Workspace · ModuleGrid · ModuleCard · SearchBar · ConfidenceBadge · SourceList · TrendingBoard
              Glossary · BilingualCompare · SettingsPanel · ModulePrompt
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
- **布局只在本机**：快照在 `localStorage`，换设备、换浏览器、清站点数据都会回到默认排布；
  换查询词也不共享（按 query 做键）。跨设备同步等 Supabase 鉴权就绪。
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
- 拖拽保存刷新仍在 ✅ `done` 后解锁拖拽，位置/尺寸落 `localStorage`，重查同一个词原样恢复；
  流式期间拖不动也存不下（已用 Playwright 断言把手不渲染、位置不变、无快照写入）

```bash
npm run typecheck   # tsc --noEmit
npm run build
```
