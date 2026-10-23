
import type { Entity } from "@/lib/schemas";

/**
 * 实体词典。这不是要代替 NER —— 它解决一个具体的工程问题：
 * GDELT DOC 索引以英文源为主，中文查询直接丢进去必然 0 结果。
 * 所以命中词典的中文实体，用它的英文别名去检索；候选词放在 Entity.candidates。
 */

type Alias = {
  zh: string[];
  en: string;
  type: Entity["type"];
};

const ALIASES: Alias[] = [
  { zh: ["英伟达", "黄仁勋"], en: "NVIDIA", type: "org" },
  { zh: ["微软"], en: "Microsoft", type: "org" },
  { zh: ["苹果公司", "苹果"], en: "Apple Inc", type: "org" },
  { zh: ["谷歌", " Alphabet"], en: "Google", type: "org" },
  { zh: ["亚马逊"], en: "Amazon", type: "org" },
  { zh: ["特斯拉"], en: "Tesla", type: "org" },
  { zh: ["台积电"], en: "TSMC", type: "org" },
  { zh: ["三星"], en: "Samsung", type: "org" },
  { zh: ["华为"], en: "Huawei", type: "org" },
  { zh: ["阿里", "阿里巴巴"], en: "Alibaba", type: "org" },
  { zh: ["腾讯"], en: "Tencent", type: "org" },
  { zh: ["字节跳动", "抖音", "tiktok"], en: "ByteDance", type: "org" },
  { zh: ["百度"], en: "Baidu", type: "org" },
  { zh: ["小米"], en: "Xiaomi", type: "org" },
  { zh: ["宁德时代"], en: "CATL", type: "org" },
  { zh: ["比亚迪"], en: "BYD", type: "org" },
  { zh: ["英特尔"], en: "Intel", type: "org" },
  { zh: ["超威", "amd"], en: "AMD", type: "org" },
  { zh: ["高通"], en: "Qualcomm", type: "org" },
  { zh: ["阿斯麦", "asml"], en: "ASML", type: "org" },
  { zh: ["openai", "欧朋艾"], en: "OpenAI", type: "org" },
  { zh: ["anthropic", "克劳德"], en: "Anthropic", type: "org" },
  { zh: ["deepseek", "深度求索"], en: "DeepSeek", type: "org" },
  { zh: ["月之暗面", "kimi"], en: "Moonshot AI", type: "org" },
  { zh: ["智谱"], en: "Zhipu AI", type: "org" },
  { zh: ["脸书", "facebook", "meta"], en: "Meta", type: "org" },
  { zh: ["x公司", "推特", "twitter"], en: "X Corp", type: "org" },
  { zh: ["spacex", "星舰"], en: "SpaceX", type: "org" },
  { zh: ["美联储"], en: "Federal Reserve", type: "org" },
  { zh: ["欧洲央行"], en: "European Central Bank", type: "org" },
  { zh: ["芯片", "半导体"], en: "semiconductor", type: "tech" },
  { zh: ["大模型", "大语言模型"], en: "large language model", type: "tech" },
  { zh: ["电动车", "电动汽车"], en: "electric vehicle", type: "tech" },
  { zh: ["光伏", "太阳能"], en: "solar power", type: "tech" },
  { zh: ["量子计算"], en: "quantum computing", type: "tech" },
  { zh: ["人形机器人"], en: "humanoid robot", type: "tech" },
  { zh: ["加息", "降息"], en: "interest rate", type: "event" },
  { zh: ["财报"], en: "earnings report", type: "event" },
];

const ZH_ALIAS = new Map<string, Alias>();
const EN_ALIAS = new Map<string, Alias>();

for (const a of ALIASES) {
  for (const z of a.zh) ZH_ALIAS.set(z.trim().toLowerCase(), a);
  EN_ALIAS.set(a.en.toLowerCase(), a);
}

/** 词典命中的中文实体 → 英文别名；未命中返回 null。 */
export function aliasOf(raw: string): Alias | null {
  const key = raw.trim().toLowerCase();
  return ZH_ALIAS.get(key) ?? EN_ALIAS.get(key) ?? null;
}

const CJK = /[\u4e00-\u9fa5]/;

/**
 * 实体抽取：词典命中 > 引号内容 > 英文专名 > 中文复合名词。
 * 顺序有讲究——词典命中带英文别名，能直接救回 GDELT 的中文查询。
 */
export function extractEntities(query: string): Entity[] {
  const out: Entity[] = [];
  const seen = new Set<string>();

  const push = (name: string, type: Entity["type"], candidates?: string[]) => {
    const clean = name.trim();
    if (clean.length < 2 || clean.length > 40) return;
    const key = clean.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(candidates ? { name: clean, type, candidates } : { name: clean, type });
  };

  // 1) 词典：整句里出现的中文/英文别名
  for (const a of ALIASES) {
    for (const z of a.zh) {
      if (query.toLowerCase().includes(z.toLowerCase())) {
        push(z, a.type, [a.en]);
        break;
      }
    }
  }

  // 2) 引号里的短语一定是用户点名的实体
  for (const m of query.matchAll(/["“”'']([^"“”'']{2,40})["“”'']/g)) {
    const a = aliasOf(m[1]);
    push(m[1], a?.type ?? "org", a ? [a.en] : undefined);
  }

  // 3) 英文专名（连续大写开头的词串）
  for (const m of query.matchAll(/[A-Z][A-Za-z0-9.&-]{1,30}(?:\s+[A-Z][A-Za-z0-9.&-]{1,30})?/g)) {
    const a = aliasOf(m[0]);
    push(m[0], a?.type ?? "org", a ? [a.en] : undefined);
  }

  // 4) 中文复合名词（以行业后缀结尾）
  for (const m of query.matchAll(/[\u4e00-\u9fa5]{2,8}(?:公司|集团|科技|汽车|银行|大学|芯片|模型)/g)) {
    const a = aliasOf(m[0]);
    push(m[0], a?.type ?? "org", a ? [a.en] : undefined);
  }

  // 全是虚词的中文查询 → 不硬造实体
  if (out.length === 0 && !CJK.test(query)) {
    const first = query.split(/\s+/)[0];
    if (first && first.length >= 2) push(first, "org");
  }

  return out.slice(0, 5);
}

/** GDELT 检索词：优先英文别名。 */
export function searchTermFor(entity: Entity): string {
  return entity.candidates?.[0] ?? entity.name;
}
