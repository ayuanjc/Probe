import { ALIASES } from "@/lib/entities";

/**
 * 话题词表：热榜聚合与历史基线必须用同一套匹配，否则
 * 「今天 12 条、前 30 天日均 3 条」会分别来自两套口径，r7 直接失去意义。
 * 所以匹配逻辑只在这里实现一次。
 */

export type TopicTerm = { match: RegExp; name: string; type: string };

// 正则元字符。不用 /[.*+?^${}()|[\]\\]/g 那种写法是为了让文件本身不出现插值模板语法。
const ESCAPE_RE = /[.*+?^$|()\[\]{}\\]/g;

function escapeRe(s: string): string {
  return s.replace(ESCAPE_RE, "\\$&");
}

/**
 * 词典里的实体直接复用，展示名取中文。
 * 只按词边界匹配英文名：HN 标题以英文为主，中文别名在这里没有命中率。
 */
const ENTITY_TERMS: TopicTerm[] = ALIASES.map((a) => {
  // zh[0] 不一定是中文（openai / amd / asml 这些别名本身就是英文小写），
  // 直接拿去展示会变成榜上写着 "openai"。有中文用中文，没有用规范英文名。
  const firstZh = a.zh[0];
  const name = /[\u4e00-\u9fa5]/.test(firstZh) ? firstZh : a.en;
  return {
    match: new RegExp("\\b" + escapeRe(a.en) + "\\b", "i"),
    name,
    type: a.type,
  };
});

/**
 * 词典覆盖不到的部分：HN 的日常话题以技术名词为主，
 * 这些不是公司也不是机构，但确实是"此刻在讨论什么"。
 */
const TECH_TERMS: { kw: string; name: string }[] = [
  { kw: "artificial intelligence", name: "人工智能" },
  { kw: "AI", name: "人工智能" },
  { kw: "LLM", name: "大语言模型" },
  { kw: "Rust", name: "Rust" },
  { kw: "Python", name: "Python" },
  { kw: "JavaScript", name: "JavaScript" },
  { kw: "TypeScript", name: "TypeScript" },
  // "Go" 不进来：英文里 Go 是常用动词，会把 "When Korean Ships Go Dark"
  // 算成 Go 语言的讨论。这类词在标题上没有可用边界，宁可漏掉。
  { kw: "Zig", name: "Zig" },
  { kw: "Kubernetes", name: "Kubernetes" },
  { kw: "Docker", name: "Docker" },
  { kw: "Linux", name: "Linux" },
  { kw: "PostgreSQL", name: "PostgreSQL" },
  { kw: "SQLite", name: "SQLite" },
  { kw: "WebAssembly", name: "WebAssembly" },
  { kw: "encryption", name: "加密" },
  { kw: "privacy", name: "隐私" },
  { kw: "security", name: "安全" },
  { kw: "DNS", name: "DNS" },
  { kw: "TLS", name: "TLS" },
  { kw: "AWS", name: "AWS" },
  { kw: "Cloudflare", name: "Cloudflare" },
  { kw: "Chrome", name: "Chrome" },
  { kw: "Firefox", name: "Firefox" },
  { kw: "Android", name: "Android" },
  { kw: "iOS", name: "iOS" },
  { kw: "EU", name: "欧盟" },
];

const TECH_TERMS_READY: TopicTerm[] = TECH_TERMS.map((t) => ({
  match: new RegExp("\\b" + escapeRe(t.kw) + "\\b", "i"),
  name: t.name,
  type: "tech",
}));

/** 词典优先：同一段文本里 NVIDIA 命中后，不再被 TECH_TERMS 的泛词重复计一次。 */
export const TOPIC_TERMS: TopicTerm[] = [...ENTITY_TERMS, ...TECH_TERMS_READY];

const TYPE_OF = new Map(TOPIC_TERMS.map((t) => [t.name, t.type]));

export function topicType(name: string): string {
  return TYPE_OF.get(name) ?? "tech";
}

/* ------------------------------------------------------------------
 * 中文标题的匹配（A 阶段）。
 *
 * 上面那套只按**英文名**匹配（\b TSMC \b），因为它的主场是 HN 的英文标题。
 * 中文标题里写的是「台积电」，一条都命中不了 —— 直接拿去给中文源用，
 * 榜单永远是空的，而空榜看起来像「今天没事发生」，不是「我们匹配不上」。
 *
 * 中文没有词边界，\b 对汉字不成立（汉字不是 \w），所以中文别名只能用
 * includes；英文别名仍然用边界，否则 "AI" 会命中 "said"。
 * 展示名与 topicType 跟英文那条完全一致 —— 同一个实体在两块榜上必须是同一个名字，
 * 否则「台积电」在中文块、「TSMC」在 HN 块，读者以为是两家公司。
 * ------------------------------------------------------------------ */

const CJK_RE = /[\u4e00-\u9fa5]/;

/**
 * 中文技术名词只收「够具体」的。
 * 为什么不是把 TECH_TERMS 全搬过来：加密 / 隐私 / 安全 在中文新闻标题里是口头禅
 * （「安全隐患」「隐私政策」），一天能命中十几条，榜单会变成这三个词的个人秀。
 * 中英文的泛词容忍度不一样，这里按中文语料重新挑，不是漏了。
 */
const ZH_TECH_WORDS = ["人工智能", "大语言模型", "欧盟"];

type ZhTerm = { name: string; type: string; test: (title: string) => boolean };

const ZH_TERMS: ZhTerm[] = [
  ...ALIASES.map((a): ZhTerm => {
    const name = CJK_RE.test(a.zh[0]) ? a.zh[0] : a.en;
    const probes: ((title: string) => boolean)[] = [];
    for (const alias of a.zh) {
      if (typeof alias !== "string" || alias.length < 2) continue;
      if (CJK_RE.test(alias)) {
        probes.push((title) => title.includes(alias));
      } else {
        const re = new RegExp("\\b" + escapeRe(alias) + "\\b", "i");
        probes.push((title) => re.test(title));
      }
    }
    // 没给出可用中文别名（比如只有 en）时退回英文边界匹配。
    if (probes.length === 0) {
      const re = new RegExp("\\b" + escapeRe(a.en) + "\\b", "i");
      probes.push((title) => re.test(title));
    }
    return { name, type: a.type, test: (title) => probes.some((p) => p(title)) };
  }),
  ...ZH_TECH_WORDS.map((word): ZhTerm => ({
    name: word,
    type: "tech",
    test: (title) => title.includes(word),
  })),
];

/** 中文标题命中的话题名（去重，词典优先）。与 matchTopicNames 返回同一套 name。 */
export function matchTopicNamesZh(title: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const term of ZH_TERMS) {
    if (seen.has(term.name)) continue;
    if (!term.test(title)) continue;
    seen.add(term.name);
    out.push(term.name);
  }
  return out;
}

/** 一条标题命中的话题名（去重，词典优先）。 */
export function matchTopicNames(title: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const term of TOPIC_TERMS) {
    if (seen.has(term.name)) continue;
    if (!term.match.test(title)) continue;
    seen.add(term.name);
    out.push(term.name);
  }
  return out;
}
