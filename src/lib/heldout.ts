/**
 * 留出集（held-out）检索的纯函数部分：怎么把一条断言变成检索词、怎么筛掉不合格的候选。
 *
 * 放在 lib 而不是 agents，是因为这两件事都不需要网络：把它们做成纯函数，
 * 单测就能钉住「同一条断言永远拼出同一个检索词」—— 否则一轮结果不可复现，
 * 用户第三次刷新看到不一样的吻合度，会以为数字是随机数。
 *
 * 真正的网络检索在 agents/heldout.ts，那里只负责调搜索接口。
 */

/**
 * 检索词上限。太长了检索质量反而下降（Tavily 这类接口对长句的处理就是切词 + 语义匹配，
 * 后半句基本不起作用），而且日志里一眼看不完。
 */
export const MAX_QUERY_CHARS = 160;

/** 引号、书名号、换行：它们在检索词里只是噪声，且会把一个词切成两段。 */
const NOISE = /[「」『』「」"'“”‘’《》〈〉\n\r\t]+/g;

function tidy(v: string): string {
  return (v || "").replace(NOISE, " ").replace(/\s+/g, " ").trim();
}

/** 只要够拼检索词的那几个字段，不要求整条 Claim —— 方便在不同层复用。 */
export type QueryClaim = {
  kind: string;
  attr: string;
  value: string;
  unit?: string;
};

/**
 * 断言 → 留出集检索词。三类可核断言各自把最独特的部分放前面：
 *
 *   - quantitative：数字 + 单位在前。「32」单独一个数在搜索结果里毫无区分度，
 *     所以单位必须紧跟数字（「32 亿」），再跟属性名。
 *   - temporal：日期在前。属性名里常带年份（「2026 年营收」），把属性放前面会把
 *     检索结果锁回原文那一篇，反过来削弱留出性。
 *   - attribution：主体在前（人名 / 机构），属性在后。这一类的关键是「谁」，不是「什么」。
 *   - existence：只检索主体。「有没有这家公司」这种断言，任何附加词都会把结果拉偏。
 *
 * 因果 / 观点 / 预测类不在核验队列里（见 claim-kind.ts），但函数仍给出合理的词，
 * 免得调用方拿到空字符串后自己去补一个。
 */
export function buildEvidenceQuery(claim: QueryClaim): string {
  const value = tidy(claim.value);
  const attr = tidy(claim.attr);
  const unit = tidy(claim.unit ?? "");
  // 值里已经带单位（"$3.2B"）时不要重复追加，否则检索词变成「$3.2B B」。
  const head = unit && !value.includes(unit) ? value + " " + unit : value;

  let q: string;
  switch (claim.kind) {
    case "existence":
      q = head || attr;
      break;
    default:
      q = (head + " " + attr).trim();
      break;
  }
  q = q.replace(/\s+/g, " ").trim();
  if (!q) return attr || value;
  return q.length > MAX_QUERY_CHARS ? q.slice(0, MAX_QUERY_CHARS).trim() : q;
}

/** 结构上与 agents/verify.ts 的 HeldoutEvidence 一致；lib 不反向依赖 agents。 */
export type HeldoutItem = {
  id: string;
  url: string;
  owner: string;
  title: string;
  text: string;
};

export function normOwner(x: string): string {
  return (x || "").trim().toLowerCase().replace(/^www\./, "");
}

/** url 去重键：去掉 query 与结尾斜杠，同一篇文章的不同追踪参数算同一条。 */
function urlKey(url: string): string {
  return (url || "").trim().replace(/[?#].*$/, "").replace(/\/+$/, "").toLowerCase();
}

export type HeldoutFilterOptions = {
  /** 每条断言最多留几条证据。判定器看 3 条以上就开始挑自己顺眼的那条。 */
  maxPerClaim?: number;
  /** 单条证据正文上限，防止一条长文把 prompt 撑爆。 */
  maxTextChars?: number;
};

export type HeldoutFilterResult = {
  kept: HeldoutItem[];
  /** 被剔掉的 id 与原因，用于 degraded 记账 —— 静默丢弃等于伪造了留出集的大小。 */
  dropped: string[];
};

/**
 * 筛候选证据：剔自证、按 url 去重、截断正文、限制条数。
 *
 * 自证是这一层最要命的失败模式：如果检索把原文引用的那家重新捞回来，
 * 那么「外部吻合度」衡量的其实是「文章与自己是否一致」，恒等于 1。
 * 所以 citedOwners 命中就整条丢弃，并在 dropped 里留一条记录。
 */
export function filterHeldout(
  evidence: readonly HeldoutItem[],
  citedOwners: Iterable<string> = [],
  opts: HeldoutFilterOptions = {},
): HeldoutFilterResult {
  const maxPerClaim = Math.max(1, opts.maxPerClaim ?? 3);
  const maxTextChars = Math.max(80, opts.maxTextChars ?? 600);
  const cited = new Set<string>();
  for (const o of citedOwners) cited.add(normOwner(o));

  const kept: HeldoutItem[] = [];
  const dropped: string[] = [];
  const seen = new Set<string>();

  for (const e of evidence) {
    if (!e || !e.id) continue;
    const key = urlKey(e.url) || e.id;
    if (cited.has(normOwner(e.owner))) {
      dropped.push("heldout:self_citation_" + e.id);
      continue;
    }
    if (seen.has(key)) {
      dropped.push("heldout:duplicate_" + e.id);
      continue;
    }
    if (kept.length >= maxPerClaim) {
      dropped.push("heldout:capped_" + e.id);
      continue;
    }
    seen.add(key);
    kept.push({ ...e, text: (e.text || "").slice(0, maxTextChars) });
  }

  return { kept, dropped };
}