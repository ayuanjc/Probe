/**
 * 术语表：界面上这些词不解释，用户只能靠猜。
 * 每条都是「用户会怎么误读」而不是词典定义 —— 解释的目的是防止误读，不是补常识。
 */

export type GlossaryKey =
  | "ambiguity"
  | "confidence"
  | "firstHand"
  | "independence"
  | "consistency"
  | "nChecked"
  | "nSyndicated"
  | "heat"
  | "articles24h"
  | "degraded"
  | "window"
  | "json";

export type GlossaryEntry = {
  label: string;
  oneLine: string;
  body: string[];
  formula?: string;
  caveat?: string;
};

export const GLOSSARY: Record<GlossaryKey, GlossaryEntry> = {
  ambiguity: {
    label: "歧义",
    oneLine: "问题本身有多不确定：同一个问法能不能指向好几件事。",
    body: [
      "0 到 1 的分数，由路由阶段给出。指代不清（「它」「这家公司」）、实体多解（同名公司 / 同名作品）、时间窗缺失，都会把它推高。",
      "超过 0.35 时，界面先给澄清卡再往下跑 —— 与其拿错实体检索一堆证据，不如先问清楚。",
    ],
    caveat: "它衡量的是问题，不是答案。歧义高不代表结论不可靠，只代表这次提问没锁定目标。",
  },
  confidence: {
    label: "置信度",
    oneLine: "这轮结论的证据强度，不是「正确概率」。",
    body: [
      "由三个分量加权：一手性 40%、独立性 35%、一致性 25%。三个分量都可以在角标里展开看原始值。",
      "它衡量「有多少条互相独立的证据支撑」，不衡量「这条结论在现实世界里为真的概率」—— 所有来源一起错，它照样给高分。",
    ],
    formula: "score = 0.40·P + 0.35·I + 0.25·C",
    caveat: "低置信时聚合数字不展示：证据不够就别给一个看起来很确定的数。",
  },
  firstHand: {
    label: "一手性 P",
    oneLine: "非转载条目在全部信源里的占比。",
    body: [
      "同一篇通稿被十家媒体转载，仍然只是一个原始出处。P 只数没被判定为转载的那些。",
      "判定靠标题与正文相似度，不保证完全准确 —— 改写过的转载可能漏掉。",
    ],
  },
  independence: {
    label: "独立性 I",
    oneLine: "独立稿源越多越接近 1，但增长会饱和。",
    body: [
      "用 n 个独立稿源按 1 − e^(−n/3) 折算：2 个来源就给到约 0.49，再往上收益递减。",
      "这是有意的：与其奖励「很多家都在说」，不如承认第 5 家带来的边际信息已经很少。",
    ],
    formula: "I = 1 − e^(−n/3)",
    caveat: "只有 1 个稿源时整体置信度封顶 0.45。",
  },
  consistency: {
    label: "一致性 C",
    oneLine: "抽出的断言之间有没有互相矛盾。",
    body: [
      "把结构化断言两两比对（数字、日期、主体）。没有可核对的断言时取 0.5 —— 不是满分，也不是零分，是「不知道」。",
      "因此当核对条数为 0 时，总分上限是 0.74：缺一致性证据，就不该出现高置信。",
    ],
  },
  nChecked: {
    label: "核对条数",
    oneLine: "实际做了交叉比对的断言数量。",
    body: [
      "0 表示这一轮没有任何断言被两两核对过（常见于只有单一来源、或断言抽取未启用）。",
      "它为 0 时一致性按 0.5 记，总分封顶 0.74。",
    ],
  },
  nSyndicated: {
    label: "疑似转载",
    oneLine: "标题高度相似、被判定为同源转载的条目数。",
    body: [
      "这些条目仍会列在信源里供你核对，但不计入独立稿源，也不计入一手性。",
      "判定是启发式的：改写幅度大的转载会漏判，所以它是一个提示，不是事实。",
    ],
  },
  heat: {
    label: "热度",
    oneLine: "过去 24 小时里，提到该话题的条目所获得的互动分数之和。",
    body: [
      "这里接的是 Hacker News 的 points：它衡量技术圈讨论量，不等于全网关注度，也不等于新闻重要性。",
      "同一话题被反复提及会累加，所以它更像「总曝光」而不是「单条最热」。",
    ],
    caveat: "GDELT 新闻索引本轮恒为降级状态（免费接口限流），热榜主要反映 HN。",
  },
  articles24h: {
    label: "条数",
    oneLine: "过去 24 小时内提到该话题的条目数，去重后。",
    body: [
      "与热度分开看：条数多说明持续被提及，热度高说明单条传播广。两者经常不同步。",
    ],
  },
  degraded: {
    label: "降级项",
    oneLine: "这一轮哪些来源没拿到数据，以及为什么。",
    body: [
      "常见原因：缺少密钥（未配置 OPENAI_API_KEY / TAVILY_API_KEY）、上游限流（GDELT）、本轮无命中。",
      "降级不等于失败：结论会在缺证据的前提下收缩，聚合数字可能因此不展示。",
    ],
  },
  window: {
    label: "时间窗",
    oneLine: "本轮检索覆盖的时间范围。",
    body: [
      "由意图解析给出，默认最近 7 天；超出窗口的旧文不进入统计。",
      "窗口越窄，命中越少但越新；置信度不会因为窗口窄而自动下降，这是已知的盲点。",
    ],
  },
  json: {
    label: "结构化输出",
    oneLine: "模型必须按固定 schema 返回，否则这条结果被丢弃。",
    body: [
      "面板数据先过 schema 校验，再过语义校验（字段必须能对上信源里的 quote）。",
      "不合规不会「修补成能看的样子」，而是整块丢弃并说明原因 —— 编造一个看起来合法的表格比空着更糟。",
    ],
  },
};

export function glossaryEntry(k: GlossaryKey): GlossaryEntry {
  return GLOSSARY[k];
}
