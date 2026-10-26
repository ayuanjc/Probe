/**
 * 来源可信度分档 —— 时间线上「谁说」的那一列。
 *
 * 这不是「真伪判定」，是**来源类型**的粗分：官方发布 ≠ 主流媒体转述 ≠ 行业媒体解读 ≠ 聚合榜单里的一句话。
 * 读者要的正是这个差别：同一条消息在 Reuters 和百度热搜里出现，重量不一样。
 *
 * 刻意保持保守：
 *   1. 只按域名与来源 id 分档，不看内容、不调模型 —— 一旦引入模型打分，
 *      我们就在替读者下结论，而这套东西的价值恰恰是「不下结论，把分歧摆出来」。
 *   2. 不认识的一律 tier 4（未分级），不要给它编一个好听的档位。
 *   3. 分档表是白名单：加域名的门槛是「你能说明它为什么属于这一档」。
 */

export type SourceTier = 1 | 2 | 3 | 4;

export type TierInfo = {
  tier: SourceTier;
  /** 中文档位名，直接印在页面上 */
  label: string;
  /** 为什么在这一档（给运维与核查用） */
  why: string;
};

/** 1 档：官方 / 一手（监管、交易所、公司自己发布、论文原文）。 */
const TIER1_HOSTS = [
  "sec.gov",
  "cninfo.com.cn",
  "sse.com.cn",
  "szse.cn",
  "hkexnews.hk",
  "pbc.gov.cn",
  "miit.gov.cn",
  "ndrc.gov.cn",
  "stats.gov.cn",
  "csrc.gov.cn",
  "arxiv.org",
  "openai.com",
  "anthropic.com",
  "nvidia.com",
  "apple.com",
  "microsoft.com",
  "huawei.com",
  "tesla.com",
  "tsmc.com",
  "byd.com",
];

/** 2 档：主流媒体（有编辑流程、署名、更正机制）。 */
const TIER2_HOSTS = [
  "reuters.com",
  "apnews.com",
  "bloomberg.com",
  "ft.com",
  "wsj.com",
  "nytimes.com",
  "bbc.com",
  "cnbc.com",
  "nikkei.com",
  "xinhuanet.com",
  "news.cn",
  "people.com.cn",
  "chinadaily.com.cn",
  "caixin.com",
  "yicai.com",
  "thepaper.cn",
  "cls.cn",
];

/** 3 档：行业媒体（有署名，但二手转述与解读占比更高）。 */
const TIER3_HOSTS = [
  "ithome.com",
  "sspai.com",
  "36kr.com",
  "techcrunch.com",
  "theverge.com",
  "wired.com",
  "arstechnica.com",
  "infoq.cn",
  "leiphone.com",
  "jiqizhixin.com",
  "huxiu.com",
];

/** 3 档：行业媒体里以社区内容为主的源（按 provider 判，没有 host）。 */
const TIER3_PROVIDERS = ["juejin"];

/** 4 档：聚合 / 社区（榜单、论坛、投票排序，没有编辑责任）。 */
const TIER4_PROVIDERS = ["baidu", "hn", "fixture", "unknown"];

export const TIER_LABELS: Record<SourceTier, string> = {
  1: "官方 / 一手",
  2: "主流媒体",
  3: "行业媒体",
  4: "聚合 / 社区",
};

function normHost(raw: string | null | undefined): string {
  let host = String(raw ?? "").trim().toLowerCase();
  if (!host) return "";
  // host 可能带端口或 www. 前缀；路径不参与判定。
  host = host.split("/")[0].split(":")[0];
  if (host.startsWith("www.")) host = host.slice(4);
  return host;
}

function matchesHost(host: string, list: readonly string[]): boolean {
  if (!host) return false;
  return list.some((d) => host === d || host.endsWith("." + d));
}

/**
 * 给一条命中定档。
 *
 * 优先级：域名 > provider。域名能说明「谁写的」，provider 只能说明「从哪个接口拿的」，
 * 所以 ithome 从 HN 聚合进来也仍然是行业媒体，而不是社区。
 */
export function sourceTier(input: { host?: string | null; provider?: string | null }): TierInfo {
  const host = normHost(input.host);
  const provider = String(input.provider ?? "").trim().toLowerCase();

  if (host && (host.endsWith(".gov") || host.endsWith(".gov.cn") || host.endsWith(".mil"))) {
    return { tier: 1, label: TIER_LABELS[1], why: "政府 / 监管域名（" + host + "）" };
  }
  if (matchesHost(host, TIER1_HOSTS)) {
    return { tier: 1, label: TIER_LABELS[1], why: "官方或一手发布源（" + host + "）" };
  }
  if (matchesHost(host, TIER2_HOSTS)) {
    return { tier: 2, label: TIER_LABELS[2], why: "主流媒体（" + host + "）" };
  }
  if (matchesHost(host, TIER3_HOSTS)) {
    return { tier: 3, label: TIER_LABELS[3], why: "行业媒体（" + host + "）" };
  }
  if (provider && TIER3_PROVIDERS.includes(provider)) {
    return { tier: 3, label: TIER_LABELS[3], why: "行业社区（provider=" + provider + "）" };
  }
  if (provider && TIER4_PROVIDERS.includes(provider)) {
    return { tier: 4, label: TIER_LABELS[4], why: "聚合榜单 / 社区投票（provider=" + provider + "）" };
  }
  return { tier: 4, label: TIER_LABELS[4], why: "未分级来源，按最低档处理" };
}
