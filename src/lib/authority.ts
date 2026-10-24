/**
 * 证据的权威度：只做「结构类别」，不做「这家媒体可不可信」的编辑判断。
 *
 * 为什么必须有这个文件：verify-events.ts 的 evidence.retrieved 事件要求每条证据带一个
 * authority 数字，grade.ts 的「上限 B / 下限 F」又拿 0.7 当门槛。如果每一步都临时
 * 拍一个数，同一篇文章两次核验就会得到两个档。所以判断集中在这里，改表即改政策。
 *
 * 三条口径（改动前先读）：
 *
 *   1. 这不是「真值概率」。0.7 的意思是「这一票够重，能参与把评级压到 B」，不是
 *      「这条来源 70% 说的是对的」。把它读成概率，就会有人开始算期望。
 *   2. 默认 0.6 与 dossier.ts 的 DEFAULT_AUTHORITY 同值、同理由：落在 0.7 门槛之下，
 *      即「没进门表的一律不足以单枪匹马否定一条断言」。默认值只有一处，改动时两边对齐。
 *   3. 分级依据是域名后缀与有限白名单，都是**结构事实**，不是内容判断。所以表里没有
 *      「某家小报 0.5」这种条目 —— 要贬一家具体媒体，得有人负责，不是代码顺手。
 */
import { DEFAULT_AUTHORITY } from "./dossier";

export type AuthorityTier = "official" | "academic" | "wire" | "general" | "ugc";

/** 每档一个数。tier 一起返回，degraded / tooltip 里要能说清「凭什么给这个分」。 */
export const AUTHORITY_TUNING: Record<AuthorityTier, number> = {
  official: 0.9,
  academic: 0.8,
  wire: 0.7,
  general: 0.6,
  ugc: 0.35,
};

/** 通讯社与设有事实核查部门的机构媒体。有限枚举，不是「我喜欢的媒体」。 */
const WIRE = [
  "reuters.com",
  "apnews.com",
  "afp.com",
  "bbc.com",
  "bbc.co.uk",
  "nytimes.com",
  "wsj.com",
  "ft.com",
  "bloomberg.com",
  "economist.com",
  "nature.com",
  "science.org",
  "xinhuanet.com",
  "news.cn",
  "caixin.com",
  "thepaper.cn",
  "yicai.com",
  "cls.cn",
];

/** 用户生成内容平台：能当线索，不能当证据（转载在这里是常态，一手性最差）。 */
const UGC = [
  "weibo.com",
  "weibo.cn",
  "x.com",
  "twitter.com",
  "zhihu.com",
  "tieba.baidu.com",
  "douban.com",
  "reddit.com",
  "medium.com",
  "substack.com",
  "blogspot.com",
  "wordpress.com",
];

const OFFICIAL_TLD = /\.(gov|mil|int)(\.[a-z]{2})?$/;
const ACADEMIC_TLD = /\.(edu|ac)(\.[a-z]{2})?$/;

/** 后缀匹配而不是 includes：`notgov.com` 不该因为含 "gov" 就升档。 */
function hit(list: readonly string[], domain: string): boolean {
  for (const d of list) {
    if (domain === d || domain.endsWith("." + d)) return true;
  }
  return false;
}

/** 取 host 去掉 www。owner 字段在库里是「域名 or 机构名」，两种都收。 */
function hostOfOwner(owner: string): string {
  const s = (owner || "").trim().toLowerCase();
  if (!s) return "";
  const noScheme = s.replace(/^https?:\/\//, "").replace(/^www\./, "");
  const slash = noScheme.indexOf("/");
  return slash >= 0 ? noScheme.slice(0, slash) : noScheme;
}

export type EvidenceAuthorityOf = { authority: number; tier: AuthorityTier };

/**
 * owner（或域名）→ 权威度。认不出的走 general/0.6，**不猜**。
 *
 * 顺序有意义：official / academic 是后缀事实，先判；白名单后判，免得某个 .gov 镜像站
 * 被白名单里的二级域抢先命中。
 */
export function authorityOf(owner: string): EvidenceAuthorityOf {
  const domain = hostOfOwner(owner);
  if (!domain) return { authority: DEFAULT_AUTHORITY, tier: "general" };
  if (OFFICIAL_TLD.test(domain)) return { authority: AUTHORITY_TUNING.official, tier: "official" };
  if (ACADEMIC_TLD.test(domain)) return { authority: AUTHORITY_TUNING.academic, tier: "academic" };
  if (hit(WIRE, domain)) return { authority: AUTHORITY_TUNING.wire, tier: "wire" };
  if (hit(UGC, domain)) return { authority: AUTHORITY_TUNING.ugc, tier: "ugc" };
  return { authority: AUTHORITY_TUNING.general, tier: "general" };
}

/** 只有进到 wire 及以上才够格参与「上限 B / 下限 F」。阈值与 grade.ts 的 0.7 同源。 */
export const HIGH_AUTHORITY = AUTHORITY_TUNING.wire;
