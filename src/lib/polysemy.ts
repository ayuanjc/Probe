
import type { Entity, Intent } from "./schemas";

/**
 * 歧义消解（PRD 2.1 的澄清卡）。
 *
 * 这里不猜「用户想问哪个意思」——猜错比不猜更糟。只做一件可核对的事：
 * 把这句话里确实存在多种读法的词，连同每种读法会检索到什么，摊开给用户选。
 * 判据是词典，不是模型自评：模型对 ambiguity 的判断很不稳定（它会为了显得谨慎
 * 给所有查询 0.4），而「苹果 = 公司 / 水果」这种事是可以写死的。
 */

export type ClarifySense = {
  /** 读法的名字，直接显示在按钮上。 */
  label: string;
  /** 选了它之后实际会发出去的查询。 */
  query: string;
  /** 一句话说明这种读法会检索到什么，避免用户凭标签瞎点。 */
  note: string;
};

/** 多义词表里的一条读法：在 ClarifySense 之外多一个语境锚点。 */
type PolySense = ClarifySense & {
  /** query 里出现它就说明用户已经指明是这种读法，不必再问。 */
  anchor: RegExp;
};

export type ClarifyEntity = {
  name: string;
  type: Entity["type"];
  /** 命中的原文词（用户可能写的是英文）。 */
  term: string;
  senses: ClarifySense[];
};

export type ClarifyPayload = {
  ambiguity: number;
  /** 为什么问这一句 —— 写判据，不写「可能有歧义」。 */
  reason: string;
  entities: ClarifyEntity[];
  timeRange: { from: string; to: string };
  dimensions: string[];
  /** 没有候选可换时的建议（例如整句都没认出主体）。 */
  advice?: string;
};


type PolyTerm = {
  match: RegExp;
  name: string;
  type: Entity["type"];
  senses: PolySense[];
};


/**
 * 多义词表。只收「两种读法会检索到完全不同信源」的词：
 * 苹果（公司 / 水果）值得问一句，英伟达不值得。
 * 英文一律带词边界 —— 这里和实体词典踩过同一个坑：
 * /apple/ 会命中 pineapple，/go/ 会命中 Google 的前三个字母。
 */
const POLY: PolyTerm[] = [
  {
    match: /苹果|\bapple(?:\s+inc)?\b/i,
    name: "苹果",
    type: "org",
    senses: [
      { label: "苹果公司（Apple Inc.）", query: "苹果公司 财报 产品", note: "公司：财报、产品线、供应链" , anchor: /财报|股价|营收|iPhone|iPad|Mac|手机|发布会|库克|App Store|市值|开发者大会/i },
      { label: "苹果（水果 / 农业）", query: "苹果 水果 价格 产量", note: "农产品：价格、产量、产地" , anchor: /水果|产地|果园|收购价|苹果汁|种植/i },
    ],
  },
  {
    match: /亚马逊|\bamazon\b/i,
    name: "亚马逊",
    type: "org",
    senses: [
      { label: "Amazon（电商 / 云）", query: "亚马逊 AWS 电商 财报", note: "公司：零售、AWS、监管" , anchor: /AWS|电商|贝索斯|Prime|零售|购物|物流|商城/i },
      { label: "亚马孙河（地理）", query: "亚马孙雨林 森林砍伐", note: "地理：雨林、生态、原住民" , anchor: /雨林|河流|砍伐|生态|巴西|原住民/i },
    ],
  },
  {
    match: /小米|\bxiaomi\b/i,
    name: "小米",
    type: "org",
    senses: [
      { label: "小米集团", query: "小米 手机 汽车 财报", note: "公司：手机、汽车、IoT" , anchor: /手机|汽车|财报|雷军|IoT|发布/i },
      { label: "小米（谷物）", query: "小米 粮食 价格 产区", note: "农产品：价格、产区" , anchor: /粮食|谷物|产区|收购|种植/i },
    ],
  },
  {
    match: /特斯拉|\btesla\b/i,
    name: "特斯拉",
    type: "org",
    senses: [
      { label: "特斯拉（Tesla Inc.）", query: "特斯拉 交付 财报 FSD", note: "公司：交付量、自动驾驶" , anchor: /交付|财报|FSD|马斯克|车型|股价/i },
      { label: "特斯拉（单位 / 人名）", query: "特斯拉 磁场 单位", note: "物理单位，或发明家 Nikola Tesla" , anchor: /磁场|单位|物理|发明家|线圈|physics|magnetic/i },
    ],
  },
  {
    match: /\brust\b/i,
    name: "Rust",
    type: "tech",
    senses: [
      { label: "Rust（编程语言）", query: "Rust programming language", note: "语言：编译器、生态、安全" , anchor: /所有权|借用|编译器|cargo|crate|编程|内存安全/i },
      { label: "锈蚀（材料）", query: "rust corrosion metal", note: "材料：腐蚀、防护、涂层" , anchor: /腐蚀|防锈|涂层|不锈钢|氧化|corrosion|rusting|rust prevention/i },
    ],
  },
  {
    match: /\bjava\b/i,
    name: "Java",
    type: "tech",
    senses: [
      { label: "Java（编程语言）", query: "Java programming language", note: "语言：JVM、生态、版本" , anchor: /JVM|字节码|编程|Spring|语言|虚拟机/i },
      { label: "爪哇（地理）", query: "Java island Indonesia", note: "地理：印度尼西亚的岛" , anchor: /岛|印尼|火山|旅游|雅加达|island|indonesia|jakarta/i },
    ],
  },
  {
    match: /\bpython\b/i,
    name: "Python",
    type: "tech",
    senses: [
      { label: "Python（编程语言）", query: "Python programming language", note: "语言：版本、生态、包管理" , anchor: /编程|解释器|pip|包管理|代码|语言/i },
      { label: "蟒蛇（动物）", query: "python snake conservation", note: "动物：物种、保护" , anchor: /蛇|动物|保护|物种|动物园|snake|reptile|pythons?\b/i },
    ],
  },
  {
    match: /\bswift\b/i,
    name: "Swift",
    type: "tech",
    senses: [
      { label: "Swift（编程语言）", query: "Swift programming language", note: "语言：iOS、并发、版本" , anchor: /编程|iOS|Xcode|语言|并发/i },
      { label: "SWIFT（跨境结算）", query: "SWIFT cross-border payments", note: "金融：清算网络、制裁" , anchor: /结算|清算|跨境|银行|制裁|汇款|swift code|payment/i },
    ],
  },
  {
    match: /\bwindows\b/i,
    name: "Windows",
    type: "tech",
    senses: [
      { label: "Windows（操作系统）", query: "Windows operating system", note: "系统：版本、补丁、驱动" , anchor: /操作系统|补丁|驱动|微软|系统/i },
      { label: "窗户（建筑）", query: "window installation building", note: "建材：安装、节能、标准" , anchor: /建筑|安装|玻璃|节能|门窗|building|glass|insulation/i },
    ],
  },
  {
    match: /\bmeta\b/i,
    name: "Meta",
    type: "org",
    senses: [
      { label: "Meta（公司）", query: "Meta platforms earnings", note: "公司：广告、Reality Labs、监管" , anchor: /财报|扎克伯格|广告|Reality Labs|股价|Instagram|WhatsApp|元宇宙/i },
      { label: "元（研究方法）", query: "meta analysis methodology", note: "研究法：元分析、综述" , anchor: /元分析|综述|论文|研究法|效应量/i },
    ],
  },
  {
    match: /长城/,
    name: "长城",
    type: "org",
    senses: [
      { label: "长城汽车", query: "长城汽车 销量 财报", note: "公司：车型、销量、出口" , anchor: /汽车|销量|车型|出口|财报|皮卡|SUV|哈弗|坦克/i },
      { label: "长城（文物保护）", query: "长城 文物保护 修复", note: "遗产：保护、修复、旅游" , anchor: /文物|保护|修复|遗产|旅游/i },
    ],
  },
  {
    match: /银河/,
    name: "银河",
    type: "tech",
    senses: [
      { label: "银河（产品线）", query: "银河 手机 产品", note: "品牌/产品：发布、评测" , anchor: /手机|产品|发布|评测|品牌|galaxy|三星/i },
      { label: "银河系（天文学）", query: "Milky Way galaxy astronomy", note: "天文：观测、结构" , anchor: /天文|星系|观测|恒星|宇宙/i },
    ],
  },
];

export type PolyHit = {
  /** 用户实际写的词（可能写成 apple）。 */
  term: string;
  name: string;
  type: Entity["type"];
  /** 仍然开放的读法：query 里没有被语境锚点排掉的那些。 */
  senses: ClarifySense[];
};

/**
 * 命中多义词表，且只保留「还没被语境排掉」的读法。
 * 苹果 + 财报 → 只可能是公司，不再问；苹果单独出现 → 两种读法都开放，问一句。
 * 剩下不到两种读法时整条不算命中 —— 一张只有一个选项的卡是噪声。
 */
export function polyHits(query: string): PolyHit[] {
  const out: PolyHit[] = [];
  for (const t of POLY) {
    const m = query.match(t.match);
    if (!m) continue;
    const open = t.senses.filter((x) => !x.anchor.test(query));
    if (open.length < 2) continue;
    out.push({ term: m[0], name: t.name, type: t.type, senses: open });
  }
  return out;
}

/**
 * 歧义度。规则可解释、可复现，且与澄清卡一一对应：
 * 有候选可换 → 出卡；没有候选且认不出主体 → 出卡给建议；其余 → 0.12。
 */
export function ambiguityOf(query: string, entities: Entity[], kind: Intent["kind"]): number {
  if (kind === "no-panel") return 0.6;
  const hits = polyHits(query);
  if (hits.length > 0) return Math.min(0.9, 0.55 + 0.1 * (hits.length - 1));
  if (entities.length === 0) return 0.4;
  if (entities.length > 3) return 0.4;
  return 0.12;
}

export function buildClarify(query: string, intent: Intent): ClarifyPayload | null {
  // no-panel 在流水线里已经早退，轮不到澄清卡；这里再守一道，避免语义漂移。
  if (intent.kind === "no-panel") return null;
  const hits = polyHits(query);
  const base = {
    ambiguity: intent.ambiguity,
    timeRange: intent.timeRange,
    dimensions: intent.dimensions,
  };

  if (hits.length > 0) {
    const first = hits[0];
    return {
      ...base,
      ambiguity: Math.max(intent.ambiguity, Math.min(0.9, 0.55 + 0.1 * (hits.length - 1))),
      reason:
        "「" + first.term + "」在这句话里有 " + String(first.senses.length) + " 种常见读法，" +
        "不同读法会检索到完全不同的信源 —— 先选一个更接近的，或者直接按现在的理解继续。",
      entities: hits.map((h) => ({ name: h.name, type: h.type, term: h.term, senses: h.senses })),
    };
  }

  if (intent.ambiguity > 0.35 && intent.entities.length === 0) {
    return {
      ...base,
      reason: "这句话里没有可检索的主体（公司 / 产品 / 人物），检索只能靠关键词硬猜。",
      entities: [],
      advice: "补一个具体主体再问，例如「宁德时代 固态电池 进展」；也可以从热榜挑一个话题直接进。",
    };
  }

  return null;
}
