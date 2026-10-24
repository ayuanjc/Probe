# 文档溯源与置信度核查 · 架构方案

> 状态：**v1.0 已完成**（§0–§6）。
> 对应 `docs/HANDOFF.md` §10.1。**方案审过再写码**；本文只定契约、公式、事件、表结构与验收，不含实现。
> 最后更新：2026-10-24。
>
> **实现落点（2026-10-24）**：§1 的口径已落为代码 —— `src/lib/claim-kind.ts`（七类 kind + 权重表，`Record<ClaimKind, number>`，少一个权重直接编译失败）、`src/agents/verify.ts`（三态 verdict、四态标签映射、不可核断言不进吻合度分母）、`src/lib/agreement.ts`（κ / AC1 / n_eff / Wilson / 加权吻合度）。`magnitudeOf()` 已从 `src/lib/text.ts` 导出。回归用例：`tests/claim-kind.test.ts`、`tests/verify.test.ts`、`tests/agreement.test.ts`（51 条全绿）。
>
> **Phase 2 落点（2026-10-24）**：`src/agents/verify-pipeline.ts` 的 `runVerify` 已从「切段 + 空分数」接到真链路 —— 逐段 `extractSegmentClaims` → `selectVerifiable` 闸门 → 逐条 `verifyOne`（推 `evidence.retrieved` / `nli.verdict`）→ `buildDossier` → `scoresFrom` 出 `doc.scored`。`hasHighAuthorityConflict()` 实现铁律 10 的下限 F / 上限 B；`src/lib/authority.ts` 用结构事实（gov/mil/int、edu/ac、白名单、UGC）给证据分档，`HIGH_AUTHORITY = 0.7`。`/api/verify` 增 `format: "json"`（脚本可断言）与 `/verify` 页；验收脚 `scripts/verify-api.mjs`（`npm run verify:api`，本轮 14 pass / 0 fail / 3 honest skip）。测试 121 条全绿。

## 0. 交付边界与三条已裁决

交付物是一篇可评审的方案，不是代码。三条已拍：

1. **低覆盖率不给字母档** → `coverage < 0.25` 或 `nJudged = 0` 时发「未充分核验」徽章，四个数照报。
2. **「谎言」一词废用** → 四态是「已支持 / 存在矛盾 / 未找到证据 / 不可核验」，矛盾态文案写「与权威来源矛盾」。
3. **矛盾单侧封顶** → 存在「≥2 独立 owner 且 authority ≥ 0.7」的矛盾时，grade 上限 B。

## 0.1 与既有半成品的关系（写码前必读）

工作区里**已经有 759 行相关代码与三份测试**（`src/agents/verify.ts` 227 行、`src/lib/agreement.ts` 415 行、`src/lib/check-worthy.ts` 117 行，加 `tests/` 下三份）。
本文不是从零设计，而是与它们对齐；能复用的不复写，能沿用的不另立口径。

| 既有 | 位置 | 与本文的关系 |
| --- | --- | --- |
| `checkWorthy` / `selectVerifiable`（阈值 0.4，返回 `savedCalls`/`savedTokens`） | `src/lib/check-worthy.ts:97` | **就是 §2.6 声明数上限的前置过滤实现**，直接复用，不再写第二套门槛 |
| `verifyClaims(claims, deps, opts)` + `blocked: no_heldout_retriever \| budget_exhausted` | `src/agents/verify.ts:104` | 就是 §2.2 的 S3 + S4 骨架；`deps = null → blocked` 正是 §4.4「诚实输出」的既有先例 |
| `citedOwners` 剔除同名 owner | `src/agents/verify.ts:63` | **就是铁律 8（自证不算支持）**，已实现，不要重写 |
| `ownerWeights` / `effectiveSampleSize` / `wilsonInterval` / `fleissKappa` / `gwetAc1` / `buildDossierView` | `src/lib/agreement.ts` | 提供 §1 的统计底座（有效样本量、置信区间、判定者一致性） |
| `DOSSIER_VISIBLE_FIELDS = [agreement, nEff, fakeConsensus]` | `src/lib/agreement.ts:331` | 已把「三个可见 + 其余进 tooltip」定成 **UI 契约**，本文 §1.6 / §5.1 服从它 |
| `tests/agreement.test.ts`、`check-worthy.test.ts`、`confidence.test.ts` | `tests/` | 已存在；本文任何落地改动不得让它们变红 |

三处口径分歧，按「既有实现优先，因为已有测试」定：

1. **主数字用 `agreement`（带 Wilson 区间），不叫 `fidelity`**。
   §1 的 `fidelity` 收敛为「`agreement.value` 的点估计」这一含义，不另立字段 —— 两个名字指同一个东西只会让代码里出现两份算法。
2. **独立源数用 `nEff`（转载权重 0.3）而非 `nOwners`**。
   `nOwners` 只作原始计数进 tooltip；界面上用户看到的应该是「相当于几个独立来源」。
3. **界面「三个可见 + 五个 tooltip」，不是四个数平铺**。
   理由见 `agreement.ts:336` 那段注释：并列的等权数字不会让信息更全，只会让用户一个都不读。
   本文 §1.6 与 §5.1 已按此改；「算不出的不显示、不填 0」这条铁律不受影响。

---
## 1. 口径层（四个数，永不合成一个百分比）

### 1.1 为什么不是「可信度 87%」

单一百分比把三件不同的事压成一个：**有多少说法被证据接住**、**有多少说法根本没法核**、**证据本身有多硬**。
三者任一为 0 时，乘积依然好看，但它什么都没说。历史上这个仓库已经踩过一次同类坑 ——
`confidence.ts:165` 那句 `nChecked === 0 → 封 0.64`，就是为了拦住「数了 40 篇、跨 26 个域名、没有一条事实被对上」的假高分。
文档核查的坑更深：一篇 90% 是观点的雄文，任何字母档都在给文风评分。所以**四个数各自报，永不合成**。

### 1.2 定义

| 名 | 中文 | 定义 | 取值 | 回答什么问题 |
| --- | --- | --- | --- | --- |
| `fidelity` | 吻合度 | Σw(已支持) ÷ Σw(已判定) | 0~1 | 能核的说法里，有多少被证据接住 |
| `contradictionRate` | 矛盾率 | Σw(存在矛盾) ÷ Σw(已判定)，即 `1 - fidelity` | 0~1 | 有多少说法被证据明确顶回来 |
| `coverage` | 可核验率 | n(可核验原子) ÷ n(全部原子) | 0~1 | 这篇东西有多少内容能拿去核 |
| `evidenceStrength` | 证据强度 | 对已判定 claim 取 mean(`q_best`) | 0~1 | 接住它的证据本身硬不硬（权威×相关×时效） |
| `confidence` | 置信度 | `evidenceStrength × independence × fidelity` | 0~1 | 这份「吻合」有多可信 |
| `grade` | 评级 | 由上面四个数按 §1.5 判定 | A+~F / N/A | 一眼结论 |

两个口径细节，必须写死在代码里而不是靠自觉：

1. **`w` 按 kind 加权**：`quantitative 1.0 / temporal 1.0 / attribution 0.9 / existence 0.8`。
   `causal / opinion / prediction` 不进分母 —— 它们不参与判定，只计入 `coverage` 的分母。
   → **已写死**在 `src/lib/claim-kind.ts` 的 `KIND_WEIGHTS`。分类优先序：
   `prediction > causal > opinion > quantitative > temporal > attribution > existence`；
   模型没给 kind 时兜底 `existence`（多烧一次检索 ＜ 把能核的说法永久踢出统计）。
2. **「已判定」的判据是 verdict，不是 claim**：`judged = 至少有一条 verdict 为 support 或 contradict 的 claim`。
   只有 `neutral` 的 claim **不算判定** —— 「没找到」不是「判过」。这条直接决定 `fidelity` 的分母，写错会让吻合度虚高。

`independence` 直接复用 `confidence.ts:18` 的 `independenceScore(n) = 1 - e^(-n/3)`；
`n` 取**全部参与判定的证据 owner 去重数**（不是支持方的 owner 数），理由见 §7 的「矛盾也要算独立」。

### 1.3 三条封顶（防「假高分」）

1. **`nJudged = 0` → `confidence = 0`，`grade = N/A`**。没有一条被核过，就不许出现高分。与 `confidence.ts:165` 同源逻辑。
2. **`coverage < 0.25` → 不发字母档**，改「未充分核验」徽章。理由见 §1.1 末句。
3. **高权威多源矛盾 → `grade` 上限 B**，无论 `fidelity` 多高。
   判据：`≥2 个独立 owner` 且其 `authority ≥ 0.7` 且都判 `contradict`。

不加额外规则的第四种情况：整篇证据只有 1 个 owner 时，`independence(1) = 0.28` 会把 `confidence` 天然压到低档，不需要再写一条封顶。

### 1.4 四态标签（「谎言」已废）

| 态 | 判据 | 左侧色条 | 面向用户的话 |
| --- | --- | --- | --- |
| 已支持 | 存在 `support` 且最强证据 `authority ≥ 0.6` | 蓝（`--accent`） | 与 N 个独立来源一致 |
| 存在矛盾 | 存在 `contradict` 且最强矛盾证据 `authority ≥ 0.6` | 红 | 与 A 矛盾（数值 / 日期 / 主体 / 极性） |
| 未找到证据 | 检索确实执行过，但无 `support` 也无 `contradict` | 中性灰虚线 | 未找到支持或反驳它的来源 |
| 不可核验 | `kind ∈ causal / opinion / prediction`，或相对时间无法定位 | 无色条 | 观点或推断，不参与核验 |

**为什么废「谎言」（写进文档，防止以后被改回去）**：

1. **举证责任不对等**：检索能证明「这个说法与权威来源不一致」，证明不了「作者明知而故犯」。
2. **归因混淆**：同一个错说法可能是转述上游出错、可能是口径差异（全年 vs 单季）、可能是我们没检索到 —— 三者在证据层面长得一模一样。
3. **产品后果**：界面一旦出现「谎言」，读者读到的不是「这条说法有反证」，而是「这个人是骗子」，而我们手里只有一个 URL 和一段 span。

### 1.5 评级表（自上而下，第一条命中即止）

| 序 | 条件 | 结果 |
| --- | --- | --- |
| 1 | `contradictionRate ≥ 0.5` 且存在高权威多源矛盾 | **F** |
| 2 | `nJudged = 0` 或 `coverage < 0.25` | **N/A（未充分核验）** |
| 3 | `confidence ≥ 0.85` 且 `coverage ≥ 0.6` 且 `contradictionRate = 0` 且 `nJudged ≥ 8` | **A+** |
| 4 | `confidence ≥ 0.75` 且 `coverage ≥ 0.5` | **A** |
| 5 | `confidence ≥ 0.65` | **B+** |
| 6 | `confidence ≥ 0.55` | **B** |
| 7 | `confidence ≥ 0.40` | **C+** |
| 8 | `confidence ≥ 0.25` | **C** |
| 9 | `confidence ≥ 0.10` | **D** |
| 10 | 其余（`nJudged ≥ 3`） | **E** |

第 1 条与第 2 条的顺序是**故意的**：「被两份权威来源顶回来」这个结论不依赖覆盖率 ——
一篇 300 字里只有 2 条事实、但两条都被官方文件否掉的东西，标「未充分核验」等于把最该说的事藏起来；
反过来，「第 3 条封顶 B」只在**正向**方向生效（不许 A），不影响 F 这个**下限**。

### 1.6 界面怎么摆这几个数（服从 `DOSSIER_VISIBLE_FIELDS`）

**主屏只放三个**（`src/lib/agreement.ts:331` 已定的 UI 契约）：

| 位置 | 字段 | 职责 |
| --- | --- | --- |
| 主数字 | `agreement.value` + Wilson 区间 | 相信多少 |
| 次数字 | `nEff` | 有多少独立来源（不是域名数） |
| 高亮 | `fakeConsensus` | 假共识，仅当反对票真实存在时给 |

其余全部进 tooltip：`coverage`、`confidence`、`evidenceStrength`、`nJudged`、`nOwners`、`κ` 与随机一致率、`nSilent`、`naive`。
**算不出来的项在 tooltip 里显示「未计」，不填 0**（铁律 1）。

> 早期草稿曾要求「四个数同屏」，已按既有实现废弃：并列的等权数字会让读者一个都不读（`agreement.ts:336`）。
2. `grade` 旁必须挂口径气泡（复用 `Glossary` 的 portal 与 `placement.ts` 的 `placeFloating`）：一句话说清「这个字母由上面四个数定，不衡量文笔、立场、来源立场」。
3. `confidence < 0.4` 时，逐段高亮只留颜色与 span，不显示 claim 权重等衍生数字；**抑制必须写进 `notes`**（铁律 2 的同一套做法）。

### 1.7 数值口径（沿用现有实现，不另写一份）

所有数值比较前先过 `src/lib/text.ts` 的 `normalizeValue()`（`3.2 billion → "3200000000"`、`1.5万 → "15000"`）。
**`magnitudeOf()` 已从 `text.ts` 导出**（2026-10-24）—— 在 verify 模块里复刻一份就等于有两套数量级口径，
两套口径必然在某天分行，而这类 bug 的表现是「一致/冲突」整体反相，最难查。

---

---

## 2. 结构层（谁被允许判断什么）

### 2.1 数据流转

```
粘贴长文 / 给出 URL            POST /api/verify { text?, url? }
        │
        ▼
S0  doc.ts        代码  纯文本直取，或 fetchArticle(url)（复用 translate.ts:76，已含 hostAllowed 逐跳复检）
        → VerifyDoc { id, title, text, chars, sourceUrl }
        ▼
S1  segments.ts   代码  splitSegments(text, 24)（复用 translate.ts:119，段落→句子，≥40 字才断句）
        → DocSegment[] { idx, charStart, charEnd, text }
        ▼
S2  claims.ts     模型A generateStructured  → 只准「拆句」，不准判真假
        → ClaimDraft[] { kind, subject, predicate, object, value?, unit?, time?, quote }
        ★ 服务端复核：quote 必须在 segment.text 里 indexOf 命中，偏移由服务端算，模型给的偏移一律丢弃
        ▼
S3  evidence.ts   模型B 出检索词 + 代码抓取（复用 retrieve.ts 的 4 路 + http.ts:180 getDirect）
        → Evidence[] { url, owner, tier, authority, publishedAt, snippet, provider }
        ▼
S4  nli.ts        模型C generateStructured，claim × top-3 证据
        → NliVerdict[] { label, modelConfidence, evidenceSpan, conflictKind, numericCheck }
        ▼
S5  score.ts      纯代码，零模型调用
        → ClaimVerdict[] + DocumentScores{ fidelity, contradictionRate, coverage, evidenceStrength, confidence, independence, grade }
        ▼
S6  spread.ts     纯代码，读 .cache/hn-history.json 与 trending
        → SpreadSignal { heatScore, status, highHeatLowEvidence }
        ▼
SSE 逐步外发 → 前端左原文右证据（§5）
```

### 2.2 五方分工表（核心：模型只在三处出现）

| 方 | 形态 | 输入 | 输出 | **被允许判断** | **禁止判断** | 失败时 |
| --- | --- | --- | --- | --- | --- | --- |
| S2 ClaimExtractor | 模型（`generateStructured`） | 单个段落原文 | 声明草案 | 这一句里**哪几个字是可核的说法**、主谓宾各是什么 | 真假、是否有争议、来源可不可信 | `claims:none` → 全文 fidelity = 0/0，grade N/A |
| S3 EvidenceScout | 模型出检索词 + 代码抓取 | 声明 | 证据列表 | **该拿什么词去查**；这段 HTML 是不是正文 | 真假、是否支持、可信度打几分 | `evidence:empty` → 该 claim 记 neutral，只降 coverage |
| S4 NliJudge | 模型（`generateStructured`） | 声明 + ≤3 条证据 span | 判定 | **这两段文字是否在说同一件事**、是否冲突（数值 / 日期 / 主体 / 极性） | 分数、权重、全文结论、评级 | `nli:failed` → 记 neutral 且 judged = false |
| S5 WeightedAggregator | 纯代码 | 判定 + 证据元数据 | 四个数与档 | **全部算术**，且只有它能写分数 | —— 无模型参与 | 无（纯函数，可单测） |
| S6 SpreadAnalyst | 纯代码 | hn-history + trending | 高热低证据候选 | 这个说法**是否正在被大量传播** | 「因为传播广所以更真/更假」 | 无历史 → 该字段不出现，不填 0 |

三条硬边界，写进代码注释：

1. **模型输出永不进入分数计算**。`authority`、`independence`、`fidelity` 全部由 S5 用代码从元数据算出 —— 与既有铁律 3「置信度不用模型自评」同一条原则，只是从「搜索结果」扩到了「文档核查」。
2. **模型给的一切偏移、位置、行号都不用**。模型只交逐字 `quote`，`charStart/charEnd` 由服务端 `indexOf` 算。理由：模型给的偏移错一位，高亮就会漂到隔壁句子，而这类错误在抽查时最容易漏。
3. **`modelConfidence` 只用于过滤，不进权重**。它是「模型自己有多确信」，不是证据强度 —— 拿它当权重的后果是：模型越自信的断言分数越高，正好与我们想要的方向相反。

### 2.3 声明身份与定位（幂等）

```
claimId = sha1(docId + ':' + segmentIdx + ':' + charStart + ':' + attr + ':' + object).slice(0, 12)
```

同一篇文档重跑，同一句话拿回同一个 `claimId` —— 前端高亮不会因为重新核验而闪烁或错位，
`NliVerdict` / `Evidence` 的外键也才有意义。一个 `quote` 在段内命中多处时取最靠前的那处，且声明只挂在它所在的那一段，不跨段。

### 2.4 五处必须由代码复核（不接受模型自述）

| # | 复核 | 不过怎么办 |
| --- | --- | --- |
| 1 | `quote` 在 `segment.text` 里 `indexOf` 必须命中 | 丢弃该声明，`notes` 里记 `claim.quote_miss: N` |
| 2 | 声明里的 `value` 折算后必须**出现在 quote 自身**里（`normalizeValue` 比对） | 丢弃 —— 防模型把「3.2 亿」写成「32 亿」这类量级事故 |
| 3 | `evidence.url` 过 `hostAllowed()` 且不私网（复用 `http.ts:126`） | 丢弃，记 `evidence:blocked` |
| 4 | `label = contradict` 且 `conflictKind = numeric` 时，必须有 `numericCheck` 且 `relativeGap > 0.05` | 降为 `neutral` —— 防「两个数字看着不像」被判成矛盾 |
| 5 | `support` 的 `owner` 不能是原文自身（同一 URL / 同一 owner） | 降为 `neutral` —— 自引不算支持 |

第 5 条值得单说：被核查的文档本身不是证据。否则一篇自己带脚注的文章会自动拿到高分，而脚注指向的正是它自己。

### 2.5 数据契约草案（`src/lib/verify/schemas.ts`，与既有 `src/lib/schemas.ts` 平级，不改动既有 schema）

```ts
export const ClaimKind = z.enum(["quantitative", "temporal", "existence", "attribution", "causal", "opinion", "prediction"]);
export const AuthorityTier = z.enum(["primary", "major", "trade", "aggregator", "unknown"]);
export const NliLabel = z.enum(["support", "contradict", "neutral"]);
export const ConflictKind = z.enum(["numeric", "temporal", "entity", "polarity", "scope", "none"]);

export const VerifyClaimSchema = z.object({
  id: z.string(),
  docId: z.string(),
  segmentIdx: z.number().int().nonnegative(),
  quote: z.string().min(4),                                  // 模型产出，必须逐字
  charStart: z.number().int().nonnegative(),                 // 服务端算，模型无权给
  charEnd: z.number().int().positive(),
  kind: ClaimKind,
  subject: z.string().min(1),
  predicate: z.string().min(1),
  object: z.string().min(1),
  value: z.number().nullable(),                              // 已过 normalizeValue 折算
  unit: z.string().nullable(),
  timeRef: z.string().nullable(),
  checkable: z.boolean(),                                    // kind ∈ quantitative|temporal|existence|attribution
});

export const VerifyEvidenceSchema = z.object({
  id: z.string(),
  claimId: z.string(),
  url: z.string().url(),
  owner: z.string(),
  tier: AuthorityTier,
  authority: z.number().min(0).max(1),                       // 由 tier + OWNER_MAP(retrieve.ts:106) 定，模型无权给
  publishedAt: z.string().nullable(),
  snippet: z.string(),
  spanInSnippet: z.string().nullable(),
  provider: z.enum(["tavily", "gdelt", "wiki", "hn", "direct", "fixture"]),
  retrievedAt: z.string(),
});

export const NliVerdictSchema = z.object({
  claimId: z.string(),
  evidenceId: z.string(),
  label: NliLabel,
  modelConfidence: z.number().min(0).max(1),                 // 只用于过滤，不进分数
  evidenceSpan: z.string().nullable(),
  conflictKind: ConflictKind,
  numericCheck: z.object({ claimValue: z.number(), evidenceValue: z.number(), relativeGap: z.number() }).nullable(),
});

export const DocumentScoresSchema = z.object({
  fidelity: z.number().min(0).max(1),
  contradictionRate: z.number().min(0).max(1),
  coverage: z.number().min(0).max(1),
  evidenceStrength: z.number().min(0).max(1),
  confidence: z.number().min(0).max(1),
  independence: z.number().min(0).max(1),
  grade: z.enum(["A+", "A", "B+", "B", "C+", "C", "D", "E", "F", "N/A"]),
  nClaims: z.number().int(),
  nCheckable: z.number().int(),
  nJudged: z.number().int(),
  nOwners: z.number().int(),
  spread: z.object({ heatScore: z.number().nullable(), status: z.string().nullable(), highHeatLowEvidence: z.boolean() }).nullable(),
});
```

`nJudged` 的口径见 §1.2：**有 support 或 contradict 的 claim 数**，只有 neutral 的不算。

### 2.6 规模上限与降级码

| 上限 | 值 | 理由 |
| --- | --- | --- |
| 文档字符数 | 40000 | 超过按段截断并发 `verify:truncated`（成本账见 §5） |
| 段落数 | 24 | 沿用 `splitSegments` 默认，超过截断 |
| 声明数 | 60 | 再多的部分是重复与修辞，收益递减而调用数线性涨 |
| 每声明证据数 | 3 | NLI 的 token 与误判率都随证据数上升 |

降级码只写事实、不写猜测（既有铁律 7）：

| 阶段 | 码 | 触发 |
| --- | --- | --- |
| S0 | `verify:fetch_failed` / `verify:not_html` / `verify:too_short` / `verify:truncated` | 复用 `fetchArticle` 的既有判定（正文 <120 字为 too_short） |
| S1 | `verify:no_segments` | 切段为空 |
| S2 | `claims:unavailable` / `claims:none` / `claims:quote_miss` / `claims:value_mismatch` | `llmEnabled() === false`（`llm.ts:32`）走 unavailable，此时直接出 N/A，不假装核过 |
| S3 | `evidence:empty` / `evidence:blocked` / `gdelt:rate_limited` | 全空只降 coverage，不降 fidelity 分母 |
| S4 | `nli:failed` / `nli:skipped` | 该 claim judged = false，进不了分母 |
| S6 | `spread:no_history` / `spread:ineligible` | 序列不足 14 天不出标签（沿用热度公式的既有约束） |

`claims:unavailable` 这条要在界面上说人话：本机没配 key 时，这个功能**会明确告诉你它没在核**，
而不是发一个 A 档。这是 §1.3 第 1 条封顶的直接后果。

---

## 3. 判定层（代码判什么，模型判什么）

### 3.1 切分表：每一项判断只有一个归属

| 判断项 | 谁判 | 判据 / 手段 |
| --- | --- | --- |
| 这句里哪几个字是「可核的说法」 | **模型** | 语义边界，代码做不了 |
| 主谓宾与 kind 分类 | **模型** | 同上；但 `kind` 落枚举、`checkable` 由代码按 kind 计算 |
| `quote` 是否真在原文里、偏移多少 | **代码** | `indexOf`，模型零权限 |
| 声明里的数值与 quote 里的数值是否一致 | **代码** | `normalizeValue` 后比对 |
| 证据这段文字是否在陈述同一件事 | **模型** | 需要语义理解 |
| 两者是否冲突、属于哪类冲突 | **模型给标签 + 代码复核** | `numeric` 类必须过 `relativeGap > 0.05` |
| 证据权威度 | **代码** | 域名 → `tier` → `authority`，见 §3.5 |
| 证据与声明的相关性 | **代码** | `tokenize` 后的 token 覆盖率 |
| 证据时效 | **代码** | `publishedAt` 与声明的 `timeRef` 之差 |
| 独立性 | **代码** | `independenceScore(nOwners)`，`confidence.ts:18` |
| 这条声明算不算「判过」 | **代码** | verdict 里存在 support / contradict |
| 分数、四态、字母档 | **代码** | §1 全部公式 |

一句话概括：**模型只看文字，代码看数字、来源、时间与权重。**
任何一格越界（比如让模型给 authority），都会把可控的错误换成不可控的错误。

### 3.2 System Prompt A —— 声明拆解

调用：`generateStructured({ schema: ClaimDraftList, system: PROMPT_A, prompt: 段落原文 })`，
temperature 0，走 `llm.ts:66`，返回 null 直接落 `claims:unavailable` / `claims:none`。
每个段落**单独一次调用**（不合并），这样某段失败不影响其他段，也便于并发。

```text
你是事实声明的拆解器。你的唯一任务是把给定段落拆成「可核验的原子事实声明」。
你不判断真假，不评价作者，不给分数。你只做结构化。

## 输出要求
每一条 claim 必须是单谓词结构：一个主体 + 一个谓词 + 一个宾语（+ 可选的数值与时间）。
复合句必须拆开：「营收 120 亿、同比增长 15%」是两条 claim，不是一条。

## 必须输出（字段含义固定）
- kind：从 quantitative / temporal / existence / attribution / causal / opinion / prediction 中选一个
- subject / predicate / object：主谓宾，用原文用词，不要翻译、不要改写成同义词
- value / unit：仅 quantitative 与 temporal 需要；value 是阿拉伯数字，unit 是原文单位（如 亿元、%、美元、Q3）
- timeRef：原文提到的时间，逐字保留（如 2025 年 Q3、上周三、今年一季度）
- quote：**原文逐字片段**，包含该声明所需的全部要素（主体、数值、时间）。不得改写、不得补字、不得跨段拼接

## 必须拒绝（不要为这些输出 claim）
1. 观点与评价：「这是最好的战略」「管理层显然误判了」
2. 预测与承诺：「明年将翻倍」「预计下半年回暖」
3. 因果与解释：「因为补贴退坡所以销量下滑」——只保留可核的那一半，因果本身丢掉
4. 修辞与比喻：「增长引擎熄火」
5. 无具体指向的泛指：「业内人士认为」「多方消息称」——除非原文明确点名了人或机构，此时 kind=attribution 且 subject 为被引述方
6. 定义性常识：「电动车用电池驱动」——无可核价值

## 引述的处理
原文引述他人说法时，kind=attribution，subject 写被引述方，object 写被引述内容，
quote 必须包含被引述方的名字。不要把它写成作者自己的断言。

## 硬性纪律
- 只输出给定段落里**确实存在**的内容。任何原文没有的数字、时间、主体，一律不得出现。
- quote 找不到可以逐字复制的片段时，宁可不输出这条 claim。
- 不确定是不是事实陈述，就不输出。宁可漏，不可造。
- 不输出解释、不输出总结、不输出道歉，只输出 JSON。

## 示例（正）
原文：公司 2025 年第三季度营收 120.4 亿元，同比增长 15%。
→ { kind: quantitative, subject: 公司, predicate: 2025Q3 营收, object: 120.4 亿元, value: 120.4, unit: 亿元, timeRef: 2025 年第三季度, quote: 2025 年第三季度营收 120.4 亿元 }
→ { kind: quantitative, subject: 公司, predicate: 2025Q3 营收同比, object: 15%, value: 15, unit: %, timeRef: 2025 年第三季度, quote: 同比增长 15% }

## 示例（负）
原文：分析师认为，这次并购是一次豪赌，明年很可能失败。
→ 不输出任何 claim。理由：前半句是 attribution 但没有具体人名与可核内容，后半句是预测。
```

### 3.3 System Prompt B —— NLI 比对

调用：一条 claim × 至多 3 条证据，**一次调用判一条证据**（不做 3 条一起判），
理由：一起判时模型倾向给折中结论，且无法定位是哪条证据支撑；单条判错的代价小得多。

```text
你是事实核验比对器。给定一条声明与一段证据文本，判断二者的关系。

## 唯一可用的信息
只有这两段文字。你不得使用任何外部知识、不得回忆新闻、不得推断「通常情况」。
证据文本里没写的东西，就当它不存在。

## 三种标签，定义互斥
- support：证据明确陈述了同一主体、同一维度、同一时间范围的同一事实。数值在容差内视为相同。
- contradict：证据明确陈述了与声明**互斥**的内容。互斥只有四种情况：
    numeric    同一指标的两个数值相对差 > 5%
    temporal   同一事件的发生时间不同，且声明给了具体时间
    entity     主体不是同一个（如声明说甲公司，证据说乙公司）
    polarity   方向相反（声明说增长，证据说下滑）
- neutral：以上都不成立。包括：证据只提到相关方但没陈述该事实、证据说的是不同口径（全年 vs 单季）、
  证据时间不明、证据与该声明只是主题相近。

## 铁律
1. 口径不同不是矛盾。声明说「2025 年全年」，证据说「2025 年 Q3」，这是 neutral + conflictKind=scope，不是 contradict。
2. 数值比较前先统一数量级：亿 / 万 / billion / million / K 都折算成同一单位再比。
3. 只是「看起来不一样」不算矛盾。必须能指出具体冲突的那一项。
4. 证据比声明更细、更多细节，不等于 support；必须是被陈述的同一件事。
5. 拿不准一律 neutral。误判 support 的代价远大于漏判。
6. evidenceSpan 必须是证据文本里的**逐字片段**，不得改写。找不到合适片段就填 null。
7. 不解释、不给建议、不评价来源可信度，只输出 JSON。

## 示例
声明：2025 年 Q3 营收 120.4 亿元。证据：财报显示 2025 年第三季度营业收入 120.4 亿元。
→ { label: support, conflictKind: none, numericCheck: null }

声明：2025 年 Q3 营收 120.4 亿元。证据：公司 2025 年 Q3 营收 98.2 亿元。（相对差 18% > 5%）
→ { label: contradict, conflictKind: numeric, numericCheck: { claimValue: 120.4, evidenceValue: 98.2, relativeGap: 0.184 } }

声明：2025 年全年营收 120.4 亿元。证据：2025 年 Q3 营收 120.4 亿元。
→ { label: neutral, conflictKind: scope }

### 3.4 四态落定表（模型标签 → 界面颜色，代码执行，不容模型插手）

| 情形 | label | 界面 | 计入分母 |
| --- | --- | --- | --- |
| 有条 support，且最强证据 authority ≥ 0.6 | support | 蓝 | 是 |
| 有条 contradict，且最强证据 authority ≥ 0.6 | contradict | 红 | 是 |
| 只有 authority < 0.6 的 support / contradict | neutral | 灰虚线 | 否 |
| NLI 失败 / 被 §2.4 复核降级 | neutral | 灰虚线 | 否 |
| kind 不可核 | —— | 无色条 | 否（只进 coverage 分母） |

「authority ≥ 0.6 才颜色」这条是刻意的：低权威来源指出的矛盾不该在界面上和官方文件同级，
但它也不会被丢掉 —— 降为 neutral 后仍然出现在右侧证据列，读者自己看得到。

### 3.5 authority 怎么算（纯代码，一次性写死）

```
tier      primary    官方 / 一手（政府、监管、财报原文、法院文书、公司公告）  base 1.00
          major      一线通讯社与老牌大报（路透、彭博、NYT、WSJ、FT、日经）    base 0.90
          trade      垂直行业媒体（TechCrunch、The Verge、36氪、财新、一财）    base 0.75
          aggregator 聚合与二手（Hacker News、知乎、维基）                      base 0.55
          unknown    未知域                                                      base 0.45

authority = base × 相关性 × 时效，三项各自封顶 1
  相关性 = tokenize(claim).intersect(tokenize(snippet)) 覆盖 claim token 的比例
  时效   = 0.5 + 0.5 × exp(-|证据时间 - 声明时间| / 72h)，任一侧无时间则取 0.7
```

`tier` 从 `retrieve.ts:106` 的 `OWNER_MAP` 派生成一张新表（`src/lib/verify/authority.ts`），
**不改动 `OWNER_MAP` 本身** —— 它服务于搜索页的独立性判重，两处语义不同，合并会互相污染。

### 3.6 自洽抽检（可选，挂在 Phase 3）

每篇抽 10% 的 claim（至少 2 条）跑第二遍 NLI，两遍标签不一致 → 该 claim 降 `neutral`，
`notes` 记 `nli:disagree: N`。成本 +10% 调用，换掉「NLI 随机性直接进结论」这条风险。
不做也可以，但那时必须承认：矛盾判定的可重复性没有经过检验。

---

## 4. 存储与接口层

### 4.1 入口：`POST /api/verify`

与 `src/app/api/search/route.ts` 同一套骨架，不新造轮子：

| 复用 | 来源 | 说明 |
| --- | --- | --- |
| `readLimit` / 滑动窗口限流 | `route.ts:31` 起的 RL 块 | 新 env `PROBE_VERIFY_RATE_PER_MIN`，**默认 2**，比 search 更紧 |
| `clientKey` | `route.ts` | `x-forwarded-for` 首段，缺省 `local` |
| `sseResponse` 写法 | `route.ts` | ReadableStream + `encodeEvent`，enqueue 失败即断开 |
| `configFromRequest` / `withRuntimeConfig` | route.ts | key 只活在 AsyncLocalStorage，不落盘 |
| `encodeEvent` / `decodeChunk` | `sse.ts:80/85` | 事件格式完全一致，前端能复用同一个 parser |

入参（二选一，同时给则以 `text` 为准）：

```ts
VerifyRequest = z.union([
  z.object({ text: z.string().min(120).max(40000) }),
  z.object({ url: z.string().url() }),
]);
// 可选参数：fresh=1（跳过缓存）、lang=zh|en、samples=0|1（关闭自洽抽检）
```

400 的四种情况分开报，不合并成一个「参数错误」：`text_too_short` / `text_too_long` / `url_not_allowed`（私网或非 http）、`empty`。

### 4.2 SSE 事件契约

```
event: doc.parsed          { docId, title, chars, truncated, segments[] }
event: claim.extracted     { segmentIdx, claims[], dropped }        // 按 segmentIdx 升序，逐段到达
event: evidence.retrieved  { claimId, evidences[], degraded[] }
event: nli.verdict         { claimId, evidenceId, label, conflictKind, authority, span }
event: spread.signal       { heatScore, status, highHeatLowEvidence }
event: doc.scored          { scores, partial }
event: done                { scores, notes[], elapsedMs, stats }
event: error               { message }
```

四条顺序保证（前端可以据此写状态机，不必自己猜）：

1. `doc.parsed` 一定是第一条；`done` 一定是最后一条（除非 `error`）。
2. 某 claim 的 `nli.verdict` 一律排在该 claim 的 `evidence.retrieved` 之后。
3. `claim.extracted` 按 `segmentIdx` 严格升序 —— 允许中间某段整段缺席（那一段是 `claims:none`），但不允许乱序。
4. `doc.scored` 在 `done` 之前且只发一次；若中途断开，**不发**（见 §4.5）。

`spread.signal` 可能整条不出现（无历史），前端不得假设它会来 —— 与 `entity.graph` 为空则整条不发是同一约定。

### 4.3 本地持久化：`.cache/verify/<docId>.json`

沿用 `src/lib/heat-history.ts` 的做法（`CACHE_DIR = path.join(process.cwd(), ".cache")`，`mkdir` + 写 `.tmp` + `rename` 原子替换），
只是子目录换成 `verify/`，文件名换成 `docId`：

```
docId = sha1(normalizedText).slice(0, 16)   // 同一篇文重跑命中同一文件，与 §2.3 的 claimId 同源

.cache/verify/<docId>.json
{
  version: 1,
  docId, title, chars, createdAt, updatedAt,
  segments: DocSegment[],
  claims: VerifyClaim[],
  evidences: VerifyEvidence[],
  verdicts: NliVerdict[],
  claimVerdicts: ClaimVerdict[],
  scores: DocumentScores | null,
  partial: boolean,
  notes: string[]
}
```

三条纪律：

1. **只缓存内容，不缓存 key**。缓存文件里不出现模型名、不出现 prompt、不出现 key（与 route.ts 的 AsyncLocalStorage 同一条原则）。
2. **`fresh=1` 强制重跑**，且重跑时 `claimId` 不变（§2.3 的幂等）—— 所以前端已有高亮不会漂。
3. **`partial: true` 的文件可以接着跑**：下次同 docId 请求且 `resume=1` 时，跳过已有的 `claim.extracted` 与 `evidence.retrieved`，只补缺的 NLI。这是长文中断后唯一的省钱路径。

### 4.4 Supabase 八表 DDL（落地先走本地 JSON，表结构先定）

仓库现在没有 Postgres / Supabase 依赖，所以 Phase 1 用 §4.3 的 JSON 等价结构；
下面 DDL 保证**同构**：字段一一对应，迁移时只换读写层，不改计算层。

```sql
-- 1 文档
create table verify_documents (
  id            text primary key,              -- docId = sha1(text)[:16]
  title         text not null default '',
  source_url    text,
  chars         integer not null,
  lang          text not null default 'zh',
  created_at    timestamptz not null default now()
);

-- 2 段落
create table doc_segments (
  id            bigserial primary key,
  doc_id        text not null references verify_documents(id) on delete cascade,
  idx           integer not null,
  char_start    integer not null,
  char_end      integer not null,
  text          text not null,
  unique (doc_id, idx)
);

-- 3 声明
create table claims (
  id            text primary key,
  doc_id        text not null references verify_documents(id) on delete cascade,
  segment_idx   integer not null,
  quote         text not null,
  char_start    integer not null,
  char_end      integer not null,
  kind          text not null,
  subject       text not null,
  predicate     text not null,
  object        text not null,
  value         numeric,
  unit          text,
  time_ref      text,
  checkable     boolean not null
);
create index claims_doc_idx on claims (doc_id, segment_idx);

-- 4 证据
create table verify_evidences (
  id            text primary key,
  claim_id      text not null references claims(id) on delete cascade,
  url           text not null,
  owner         text not null,
  tier          text not null,
  authority     numeric not null check (authority between 0 and 1),
  published_at  timestamptz,
  snippet       text not null,
  span          text,
  provider      text not null,
  retrieved_at  timestamptz not null default now()
);
create index evidence_claim_idx on verify_evidences (claim_id);

-- 5 NLI 逐条判定
create table nli_verdicts (
  id             bigserial primary key,
  claim_id       text not null references claims(id) on delete cascade,
  evidence_id    text not null references verify_evidences(id) on delete cascade,
  label          text not null check (label in ('support','contradict','neutral')),
  model_conf     numeric not null,
  evidence_span  text,
  conflict_kind  text not null,
  numeric_check  jsonb,
  unique (claim_id, evidence_id)
);

-- 6 claim 级汇总（界面读这一张就够）
create table claim_verdicts (
  claim_id       text primary key references claims(id) on delete cascade,
  state          text not null check (state in ('supported','contradicted','no_evidence','unverifiable')),
  judged         boolean not null,
  weight         numeric not null,
  best_evidence  text references verify_evidences(id),
  authority      numeric,
  n_support      integer not null default 0,
  n_contradict   integer not null default 0
);

-- 7 文档级分数
create table document_scores (
  doc_id            text primary key references verify_documents(id) on delete cascade,
  fidelity          numeric not null,
  contradiction_rate numeric not null,
  coverage          numeric not null,
  evidence_strength numeric not null,
  confidence        numeric not null,
  independence      numeric not null,
  grade             text not null,
  n_claims          integer not null,
  n_checkable       integer not null,
  n_judged          integer not null,
  n_owners          integer not null,
  partial           boolean not null default false,
  computed_at       timestamptz not null default now()
);

-- 8 检索运行记录（成本与降级码都落这里）
create table retrieval_runs (
  id            bigserial primary key,
  doc_id        text not null references verify_documents(id) on delete cascade,
  stage         text not null,
  provider      text,
  calls         integer not null default 0,
  tokens_in     integer not null default 0,
  tokens_out    integer not null default 0,
  degraded      text[] not null default '{}',
  elapsed_ms    integer not null default 0,
  created_at    timestamptz not null default now()
);
create index runs_doc_idx on retrieval_runs (doc_id, stage);
```

RLS 策略：八表全部 `enable row level security` 且**只给 service role**，不开放 anon 读写。
理由很实际 —— 这八张表的 `text` / `snippet` 存的是用户粘贴的原文与抓来的第三方正文，本质上不是公开数据。

### 4.5 限流、尺寸、中断、partial

| 维度 | 处置 |
| --- | --- |
| 限流 | 默认 2 次/分钟/client，429 带 `retry-after`（复用 route.ts 的 `guarded()`） |
| 文本长度 | ≤ 40000 字符；超长不悄悄截断，先发 `doc.parsed{truncated:true}` 再继续，`notes` 记 `verify:truncated` |
| 并发 | 段与段之间并发 2（拆声明与 NLI 都是），**GDELT 仍走 `retrieve.ts` 的全局串行化**，不许绕过 |
| 单次总时长 | 90s 软上限；到点停发新的 NLI，已完成的照常 `doc.scored{partial:true}` |
| 客户端断开 | `signal` 传到底，立刻停；**已产生的中间结果写进 `.cache/verify/` 并标 `partial:true`**，下次可 `resume=1` |
| 服务端错误 | 发 `error` 收尾，不吞；已写出的部分留在缓存文件里 |

`partial` 与 §1.3 的 N/A 是两件不同的事，界面上别混：

- `N/A` = 覆盖率不足，**判定不了**（结论：这文不给定论）；
- `partial` = 覆盖率够但**这次没跑完**（结论：结论可信，但只覆盖了一部分）。
  `partial: true` 时字母档照给，旁边标「部分核验 · 中断于第 X 段」。

### 4.6 与既有 `/api/search` 的关系

**完全不动**。新接口新文件（`src/app/api/verify/route.ts`）、新事件联合类型（`VerifyEvent`）、新 schema 文件（`src/lib/verify/*`）。
唯一两处「共用但不修改」：`sse.ts` 的 `encodeEvent`/`decodeChunk`（纯编解码，与业务无关）与 `http.ts` 的 `getDirect`/`hostAllowed`。
这样做的好处是：search 那 35 项接口断言（`full-api.mjs`）不需要因为新功能重跑逻辑，只要补 verify 自己的断言。

---

## 5. 前端与预算层

### 5.1 结果页结构（左原文、右证据）

```
┌─────────────────────────────────────────────────────────────┐
│ 吻合度 0.61  [0.48–0.72]   nEff 4.7   未见假共识       B+    │  ← 三个可见 + 档，其余进 tooltip
│  ⓘ coverage 0.44 · confidence 0.61 · nJudged 19 · nOwners 8   │  ← hover/聚焦才出，走 placeFloating
├──────────────────────────────┬──────────────────────────────┤
│ 原文（可滚动，段为单元）      │ 证据列（跟随选中段）          │
│                              │                              │
│ ▎公司 Q3 营收 120.4 亿元，    │ ［已支持］2 条                │
│ ▎同比增长 15%。              │  · 财报原文   primary 0.94    │
│  ↑ 蓝色左边框 + 段内下划线    │  · 路透社     major   0.81    │
│                              │  ────────────────            │
│ ▎分析师称这是豪赌。          │ ［存在矛盾］1 条              │
│  ↑ 红条（数值 18% 偏差）      │  · 检索到的原文  0.90         │
│                              │                              │
│ ▎这是最好的战略。            │  （无证据 · 观点不参与核验）  │
│  ↑ 无色条，灰字              │                              │
└──────────────────────────────┴──────────────────────────────┘
```

复用现有约定，不重新发明：

| 需要 | 复用 | 备注 |
| --- | --- | --- |
| 浮层定位 | `src/lib/placement.ts` 的 `placeFloating` | **只剩这一份算术**，不再写第二份 |
| 口径气泡 / 术语 | `Glossary`（portal + fixed，不锁滚动） | 非模态，Esc 关闭 |
| 渐进披露 | README §交互的七件小事 | 先给结论、段级按需展开 |
| 想关掉的提示 | `probe:grid-hint:v1` 同款可关记忆 | 新 key `probe:verify-hint:v1` |
| 动效 | `prefers-reduced-motion` + 设置开关 | 高亮不许有位移，只许变色 |

### 5.2 三色左边框的规范（含色盲兜底）

| 态 | 左边框 | 段内标记 | 文字标签 |
| --- | --- | --- | --- |
| 已支持 | 3px 实线，`--accent`（沿用主题蓝） | 声明 span 下划细线 | 段尾徽章「2 条支持」 |
| 存在矛盾 | 3px 实线，红 | 冲突数值加波浪下划线 | 段尾徽章「1 条反证」 |
| 未找到证据 | 3px **虚线**，中性灰 | 无 | 段尾徽章「未找到」 |
| 不可核验 | 无边框，左侧留同宽空白 | 无 | 无（保持阅读连续） |

三条硬要求：

1. **不许只靠颜色区分**。实线 / 虚线 / 无边 + 徽章文字三重冗余 —— 色盲用户与黑白打印都要能读。
2. **同一段里两种态并存时**，边框取「更需注意」的那一个（矛盾优先），段内按 claim 分别着色。
3. **高亮不改变行高与字距**。声明下划线用 `text-decoration-thickness: 1px` + `text-underline-offset: 3px`，
   禁止 `border-bottom`（会挤动行距，长文里滚动时会抖）。自定义 CSS 全部留在 `@layer base`（既有铁律 10）。

### 5.3 状态机（SSE → UI）

新 hook `useVerify()`，结构对齐 `useProbe.ts:30` 的 `ProbeState`：

```ts
type VerifyState = {
  status: "idle" | "running" | "done" | "failed";
  doc: { docId: string; title: string; segments: DocSegment[] } | null;
  scores: DocumentScores | null;         // doc.scored 到达前为 null —— 顶部评级条显示骨架，不显示 0
  segments: Record<number, SegmentState>; // 按 segmentIdx 增量填充，允许空洞
  selected: { segmentIdx: number; claimId?: string } | null;
  notes: string[];
  partial: boolean;
};
```

三条与既有 hook 一致的做法（照抄，不另立规矩）：

1. **轮次令牌**（`seqRef`）：新一次核验开始时旧流的一切事件失效，避免两次结果串台。
2. **rAF 合帧**：`text.delta` 在 search 里用合帧，这里 `claim.extracted` 同理 —— 24 段在 2 秒内密集到达时不要每来一条就 setState。
3. **StrictMode 下卸载不立刻 abort**：开发环境双挂载会把正在跑的流掐断，表现为「第一次永远是空的」。

### 5.4 手机降级（390 / 360 宽）

| 桌面 | 手机 |
| --- | --- |
| 左右双栏 | 单栏；证据列变成**底部抽屉**（`fixed bottom-0`，最大 45vh，可拖高） |
| 3px 左边框 | 3px 左边框保留（窄但可留），徽章移到段尾行内 |
| 悬停预览证据 | 点段 → 抽屉展开；再点收起（触屏无 hover） |
| 评级条四项横排 | 两项一行折行；`?` 气泡改全屏 sheet |

验收沿用 `mobile-audit.py` 的既有口径：390 与 360 宽**无横向溢出**（`scrollWidth <= clientWidth + 1`）。
抽屉最大高度必须用 `dvh` 而非 `vh`，否则 iOS 地址栏收起时会盖住半屏。

### 5.5 成本与延迟账（能不能上线就看这一节）

按上限一篇算：40000 字符 / 24 段 / 60 条可核声明。

**调用数**

| 阶段 | 原始量 | 削减后 | 削减手段 |
| --- | --- | --- | --- |
| S2 拆声明 | 24 次（每段一次） | 24 | 已是最小；段内不再切 |
| S3 检索 | 60 claim × 3 provider = 180 HTTP | ~110 HTTP | 查询词先 `tokenize` 去重；同段同类 claim 合并成一条 query；只对 `checkable` 检索 |
| S4 NLI | 60 × 3 = 180 次 | **≤ 90 次** | ①每 claim 只对**相关性最高的 1 条**跑首轮；②仅当首轮 `neutral` 且 `conflictKind` 可疑、或有第二个 owner 时补第 2 条；③超过 30 条 claim 时每段最多 2 条分层抽样 |
| 合计 | —— | **≤ 120 次** | 硬上限 120，到顶停并标 `partial` + `verify:budget` |

**Token 与钱**（按 gpt-4o-mini 级价位估）

| 项 | 量级 |
| --- | --- |
| 输入 | ≈ 150k tokens（拆声明 30k + NLI 108k + 检索上下文 12k） |
| 输出 | ≈ 18k tokens |
| 单篇成本 | ≈ $0.03（¥0.25 上下），按 2 次/分钟限流，单客户端峰值 ¥0.5/分钟 |

**延迟（并发 4）**

| 里程碑 | 时间 |
| --- | --- |
| `doc.parsed` | 0s |
| 首段可读（拆声明 + 检索 + NLI 走完） | **12–15s** |
| 半篇 | 35–45s |
| 全文 `done` | 60–85s |

两条由此决定的硬要求：

1. **必须按段流水，不许按阶段串行**。段 1 在跑检索时，段 3 应该已经在拆声明。
   串行做的话首屏要等 40s 以上，用户会以为卡死 —— 而它其实什么都没坏。
2. **顶部评级条在 `doc.scored` 到达前不显示数字**，只显示骨架。真实分数必须等全部判定收口，
   这里不许「先估一个」，那是把 §1 的口径直接作废。

---

## 6. 收口

### 6.1 本功能自己的 12 条铁律（与仓库既有铁律并列，冲突时以更严者为准）

1. **模型只拆句、只判关系**，永不产出分数、字母、权重、authority。
2. **模型给的偏移一律不用**，`quote` 由服务端 `indexOf` 定位。
3. **`quote` 必须逐字命中原文**，命中失败即丢弃该声明，不做模糊匹配、不做近似替换。
4. **数值先折算量级再比**，且声明的 `value` 必须出现在它自己的 `quote` 里。
5. **「未找到」不是「判过」**：只有 neutral 的 claim 不进 fidelity 分母。
6. **无证据只降 coverage 与 confidence**，绝不记为矛盾。
7. **口径不同不是矛盾**：全年 vs 单季 → `neutral + scope`。
8. **被核文档自身不算证据**，自证不得 support。
9. **`coverage < 0.25` 或 `nJudged = 0` 时不给字母档**，只给「未充分核验」徽章，四个数照报、算不出的不填 0。
10. **上限与下限并存**：`contradictionRate ≥ 0.5` 且存在高权威多源矛盾 → 直接 F（下限，优先于 N/A）；
    存在该矛盾但矛盾率不高 → 档位上限 B（上限，不许 A）。
11. **抑制、降级、丢弃都要写进 `notes` 并外发到 `done`**；降级码只写事实（`claim.quote_miss: 3`），不写猜测原因。
12. **主屏只放三个数**（`agreement` / `nEff` / `fakeConsensus`），其余进 tooltip；评级必须带口径气泡，说明它由哪些数决定，不衡量文笔、立场、来源立场。

### 6.2 分三个阶段，每阶段都可独立验收

| 阶段 | 内容 | 验收口径 |
| --- | --- | --- |
| **Phase 1** 无模型闭环 | 入口 + 切段 + 本地缓存 + 双栏骨架 + `claims:unavailable` 诚实提示 | `curl -N -X POST /api/verify -d 一段 1500 字` 收到 `doc.parsed` → `done`；`grade = N/A`；`notes` 含 `claims:unavailable`；顶部不显示任何分数 |
| **Phase 2** 接模型 | 拆声明 + 检索 + NLI + 评分 + 高亮 | `npx tsc --noEmit` = 0；`next build` 过；新增 `verify-api.mjs` 断言全绿（见下）；`full-api.mjs` 35/35 与 `full-ui.py` 31/31 **不回归** |
| **Phase 3** 体验与扩展 | 抽样自洽、快速模式、Supabase 迁移、传播加权、移动抽屉拖拽 | `mobile-audit.py` 390/360 无溢出；抽样不一致率有记录；快速模式明标「前 8 段」 |

Phase 2 的 `verify-api.mjs` 至少这 11 条断言，每条对一条铁律：

| # | 断言 | 对应 |
| --- | --- | --- |
| 1 | 伪造 quote（原文里不存在）→ 该 claim 不出现，`notes` 含 `claim.quote_miss` | 铁律 3 |
| 2 | 声明值 120.4 但 quote 写 32 → 丢弃 | 铁律 4 |
| 3 | `3.2 billion` 与 `32 亿` 判为同一数值（support） | 铁律 4 |
| 4 | 全年 vs Q3 → `neutral` + `scope`，不进矛盾率 | 铁律 7 |
| 5 | 数值相对差 2% → `neutral`（不判矛盾） | §3.1 |
| 6 | 只有 neutral 的一篇 → `nJudged = 0` → `grade = N/A` | 铁律 5 / 9 |
| 7 | 观点为主的 200 字 → `coverage < 0.25` → 字母档为 `N/A` 且四个数都在 | 铁律 9 |
| 8 | 两条高权威矛盾 → `grade` 不高于 `B` | 铁律 10 |
| 9 | `url = http://127.0.0.1:6379/` → 400 `url_not_allowed` | 铁律 8 同族（SSRF） |
| 10 | 40001 字符 → 先发 `truncated: true` 再继续，`notes` 含 `verify:truncated` | §4.5 |
| 11 | 中途 `kill curl` → 缓存文件 `partial: true` 且已写入前几段 | §4.5 |

### 6.3 复用清单（写码时只准用这些，不许再造第二份）

| 需求 | 复用 | 位置 |
| --- | --- | --- |
| 切段 | `splitSegments` | `src/lib/translate.ts:119` |
| 抓正文 / 去标签 | `fetchArticle` / `toText` | `src/lib/translate.ts:76` |
| 出网 + SSRF 闸门 | `getDirect` / `hostAllowed` | `src/lib/http.ts:180` / `:126` |
| 结构化模型输出 | `generateStructured` | `src/lib/llm.ts:66` |
| SSE 编解码 | `encodeEvent` / `decodeChunk` | `src/lib/sse.ts:80` / `:85` |
| 独立性 | `independenceScore(nOwners)` | `src/lib/confidence.ts:18` |
| 转载判重 | `findSyndicatedIds` | `src/lib/confidence.ts` |
| owner 归一 | `ownerOf` | `src/lib/confidence.ts` |
| 数值折算 | `normalizeValue` + `magnitudeOf`（已导出） | `src/lib/text.ts:78` |
| 相似度 | `tokenize` / `jaccard` / `titleSimilarity` | `src/lib/text.ts` |
| 浮层定位 | `placeFloating` | `src/lib/placement.ts` |
| 原子写盘 | `mkdir` + 写 `.tmp` + `rename` | `src/lib/heat-history.ts` |
| 限流 / 客户端键 | `readLimit` / `clientKey` / `guarded` | `src/app/api/search/route.ts` |
| 口径气泡 | `Glossary` | `src/components/` |

### 6.4 做不到清单（明写在界面上，不装能）

| # | 做不到 | 界面上怎么说 |
| --- | --- | --- |
| 1 | 证明「作者说谎」 | 只出「与权威来源矛盾」，永不出「谎言」（§1.4 三条理由） |
| 2 | 判定观点、预测、因果的对错 | 标「不可核验」，只进 coverage 分母，不参与评分 |
| 3 | 图片、图表、视频里的数字 | 只处理纯文本；粘贴图片直接 400 `unsupported_media` |
| 4 | 付费墙后的正文 | 记 `verify:too_short` 或 `verify:fetch_failed`，不猜内容 |
| 5 | 跨语言比对 | 声明与证据语言不同 → 不跑 NLI，标「未找到证据」并记 `nli:lang_mismatch`。中文声明配英文证据时误判率不可控，宁可不判 |
| 6 | GDELT 争议 / 情绪维度 | DOC API 全局限流 429（本机与服务器均不可用），该维度不存在 |
| 7 | 非中英文本地媒体 | 检索层只有 4 路，覆盖不到的部分表现为低 coverage —— 这是「我们没查到」，不是「没有」 |
| 8 | 文章级立场评分 | 不做。这个功能核事实，不核立场 |
| 9 | 绝对可重复 | NLI 有随机性；Phase 3 抽样只缓解不消除 |

第 5 条是这一节里最容易被忽略、后果最大的一条：跨语言 NLI 的误判方向是**系统性偏向 neutral**，
看起来「保守」，实际会让中文文章里引用的英文数据全部漏判 —— 这必须说出来，不能藏在覆盖率数字里。

### 6.5 一页速查

```
入口      POST /probe/api/verify   { text | url }   fresh=1 / resume=1 / samples=0
限流      默认 2 次/分钟/client（PROBE_VERIFY_RATE_PER_MIN）
事件序    doc.parsed → claim.extracted* → evidence.retrieved → nli.verdict*
          → [spread.signal] → doc.scored → done
缓存      .cache/verify/<sha1(normalizedText)[:16]>.json（原子写，partial 可续）
四口径    fidelity / coverage / evidenceStrength / confidence  永不合成单一百分比
等级      A+ A B+ B C+ C D E F / N/A      上限 B（高权威矛盾）· 下限 F（矛盾率 ≥ 0.5）
硬顶      40000 字符 / 24 段 / 60 声明 / 每声明 3 证据 / 120 次模型调用
成本      ≈ $0.03 · ¥0.25 每篇；首段可读 12–15s，全文 60–85s
```

---

**本文档 v1.0 完成。** 未写任何实现代码；下一步按 §6.2 的 Phase 1 开工。