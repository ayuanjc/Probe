import { aliasOf } from "@/lib/entities";

/**
 * 关注对象的「匹配层」。
 *
 * 为什么要单独一层：关注是**被动推送**，推错一次的代价远高于漏推一次 ——
 * 用户会从此不看那个未读数。所以这里的原则是「宁可少推，不可乱推」：
 *   - 英文别名必须词边界命中，否则 "meta" 命中 "metadata"、"eu" 命中 "europe"；
 *   - 歧义词（苹果/小米/长城/亚马逊…）必须同时出现上下文词才算命中（见 AMBIGUOUS_CONTEXT）；
 *   - 不确定就**不推**，并把「因为歧义跳过」单独计数，运维在后台看得见。
 *
 * 刻意不在这里调模型：一次 cron 要判几百条标题，模型复核会把定时任务变成账单。
 * 真需要模型的那一档（L3）留给以后用显式开关，且必须记点。
 */

export type WatchKind = "org" | "tech" | "person" | "geo" | "event" | "other";

export const WATCH_KINDS: WatchKind[] = ["org", "tech", "person", "geo", "event", "other"];

export const KIND_TEXT: Record<string, string> = {
  org: "机构 / 公司",
  tech: "技术",
  person: "人物",
  geo: "地区",
  event: "事件",
  other: "其他",
};

export type WatchKey = { name: string; key: string; aliases: string[]; kind: WatchKind };

const CJK = /[\u4e00-\u9fa5]/;

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 归一化一个关注名。
 *
 * 词典命中时用词条做键（「台积电」与「TSMC」是同一个关注，不会出现两条），
 * 展示名优先取中文别名（用户输入中文就看中文）；未命中就原样保留、kind=other。
 * 键取展示名的小写：跨用户的去重不在这里做，UNIQUE(user_id, key) 只管同一个人不重复。
 */
export function watchKeyOf(raw: string): WatchKey | null {
  const name = String(raw ?? "").trim().replace(/\s+/g, " ").slice(0, 40);
  if (name.length < 2) return null;
  const alias = aliasOf(name);
  if (alias) {
    const zh = alias.zh.filter((z) => CJK.test(z));
    const display = zh[0] ?? alias.en;
    const aliases: string[] = [];
    for (const a of [...alias.zh, alias.en]) {
      const v = a.trim();
      if (v && !aliases.some((x) => x.toLowerCase() === v.toLowerCase())) aliases.push(v);
    }
    return { name: display, key: display.toLowerCase(), aliases, kind: alias.type as WatchKind };
  }
  return { name, key: name.toLowerCase(), aliases: [name], kind: "other" };
}

/**
 * 歧义词的上下文要求。键是别名的小写形式，值是「算命中」的上下文正则。
 *
 * 只放真的会出事的：这些词在热榜标题里日常以另一个意思出现。
 * 加新词的门槛是「你能举出一条被推错的真实标题」，否则别加 —— 每加一条就多一层漏推。
 */
export const AMBIGUOUS_CONTEXT: Record<string, RegExp> = {
  苹果: /(苹果公司|公司|股价|市值|财报|发布|供应链|iphone|ipad|mac\b|库克|ceo|app store|应用商店)/,
  "apple inc": /(inc\b|公司|股价|市值|财报|iphone|ipad|mac\b|库克|ceo|app store|supplier)/,
  apple: /(inc\b|公司|股价|市值|财报|iphone|ipad|mac\b|库克|ceo|app store|supplier)/,
  小米: /(公司|股价|手机|汽车|su7|雷军|财报|发布|xiaomi)/,
  xiaomi: /(公司|股价|手机|汽车|su7|雷军|财报|发布)/,
  长城: /(汽车|公司|股价|哈弗|坦克|suv|wey)/,
  亚马逊: /(公司|aws|电商|股价|贝索斯|prime|云服务|财报)/,
  amazon: /(公司|aws|电商|股价|贝索斯|prime|云服务|财报)/,
  三星: /(公司|电子|手机|芯片|财报|股价|galaxy|samsung)/,
  samsung: /(公司|电子|手机|芯片|财报|股价|galaxy)/,
  特斯拉: /(公司|股价|财报|马斯克|musk|汽车|cybertruck|model [3sy])/,
  tesla: /(公司|股价|财报|马斯克|musk|汽车|cybertruck|model [3sy])/,
  阿里: /(集团|巴巴|股价|电商|淘宝|蚂蚁|财报|alibaba)/,
  alibaba: /(集团|巴巴|股价|电商|淘宝|蚂蚁|财报)/,
  百度: /(公司|股价|搜索|财报|文心|apollo|自动驾驶)/,
  腾讯: /(公司|股价|财报|微信|游戏|wechat)/,
};

/** 英文别名必须有词边界；中文按子串（没有分词器，双字以上已经很具体）。 */
export function containsAlias(hay: string, alias: string): boolean {
  const h = hay.toLowerCase();
  const a = alias.trim().toLowerCase();
  if (!a) return false;
  if (CJK.test(a)) return h.includes(a);
  return new RegExp("(^|[^a-z0-9])" + escapeRe(a) + "($|[^a-z0-9])").test(h);
}

export type MatchOutcome = { matched: boolean; ambiguous: boolean };

/** 一条标题对上一个关注：命中 / 因歧义跳过 / 无关。 */
export function matchStory(target: Pick<WatchKey, "aliases">, title: string): MatchOutcome {
  const hay = String(title ?? "").toLowerCase();
  if (!hay) return { matched: false, ambiguous: false };
  let sawAlias = false;
  for (const alias of target.aliases) {
    if (!containsAlias(hay, alias)) continue;
    sawAlias = true;
    const ctx = AMBIGUOUS_CONTEXT[alias.trim().toLowerCase()];
    if (!ctx) return { matched: true, ambiguous: false };
    if (ctx.test(hay)) return { matched: true, ambiguous: false };
  }
  return { matched: false, ambiguous: sawAlias };
}
