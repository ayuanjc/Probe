/**
 * 区域判定：这个请求该按哪套数据出境规则处理。
 *
 * 为什么不是"看到中文就按国内"：语言和法域是两件事。在德国的华人查中文新闻，
 * 数据往哪走由他的网络位置决定，不由他打什么字决定。
 *
 * 判定顺序（先便宜、先可信，后昂贵、后推算）：
 *   1. 运维显式固定 PROBE_REGION_MODE=cn|intl —— 一次部署只服务一个区域时最不容易错；
 *   2. 边缘节点注入的国家头（Cloudflare / EdgeOne / Vercel 都会加）—— 最可信的实时信号；
 *   3. IP 反查（只有配了 PROBE_REGION_LOOKUP_URL 才走）—— 直连部署没经过 CDN 时的补位；
 *   4. 兜底 PROBE_DEFAULT_REGION，默认 "cn"。
 *
 * 兜底为什么是 cn 而不是 intl：判错的代价不对称。把境内用户误判成境外，等于把查询内容
 * 发了出去（不可撤回）；把境外用户误判成境内，只是少用几个源（可恢复）。合规开关一律倒向严格那边。
 */

import { clientKey } from "./request-guard";

export type Region = "cn" | "intl";

export type RegionSource = "mode" | "header" | "ip" | "default";

export type RegionHit = { region: Region; source: RegionSource; country?: string };

// 中文名也要认：境内 IP 库（腾讯位置服务等）返回的常常是"中国"而不是 "CN"。
const CN_CODES = new Set(["CN", "CHN", "CHINA", "中国", "中國", "中华人民共和国"]);
const UNKNOWN_CODES = new Set(["", "-", "N/A", "NONE", "UNKNOWN", "XX", "T1", "A1", "A2", "EU"]);

/** 国家码 → 区域。识别不了的返回 null（交给下一级判定，而不是当场猜一个）。 */
export function regionFromCountry(raw: string | null | undefined): Region | null {
  const code = String(raw ?? "").trim().toUpperCase();
  if (!code || UNKNOWN_CODES.has(code)) return null;
  if (CN_CODES.has(code)) return "cn";
  if (/^[A-Z]{2,3}$/.test(code)) return "intl";
  return null;
}

/**
 * 运维/配置里的区域写法。
 * "auto" 返回 null（表示"别用我，继续往下判"），而不是当成默认值 ——
 * 否则 PROBE_REGION_MODE=auto 会静默变成"固定 cn"。
 */
export function parseRegionWord(raw: string | null | undefined): Region | null {
  const v = String(raw ?? "").trim().toLowerCase();
  if (!v || v === "auto") return null;
  if (v === "cn" || v === "china" || v === "mainland" || v === "zh-cn") return "cn";
  if (v === "intl" || v === "international" || v === "global" || v === "overseas" || v === "world") return "intl";
  return regionFromCountry(v);
}

/** 自家反代可以显式注入这个头；也可以直接写国家码。 */
const REGION_HEADER = "x-probe-region";

/** CDN / 边缘节点常见写法。顺序即优先级：越靠前越可信。 */
const COUNTRY_HEADERS = [
  "eo-client-ipcountry", // 腾讯云 EdgeOne
  "cf-ipcountry", // Cloudflare
  "x-vercel-ip-country",
  "x-country-code",
  "x-geo-country",
  "x-real-ip-country",
  "x-probe-country",
];

export function regionFromHeaders(get: (name: string) => string | null): RegionHit | null {
  const explicit = parseRegionWord(get(REGION_HEADER));
  if (explicit) return { region: explicit, source: "header" };

  for (const name of COUNTRY_HEADERS) {
    const raw = get(name);
    if (!raw) continue;
    const region = regionFromCountry(raw);
    if (region) return { region, source: "header", country: raw.trim().toUpperCase().slice(0, 8) };
  }
  return null;
}

/**
 * 地址归一化。
 *
 * 存在的唯一理由：Node 在双栈 socket 上给出的是 IPv4-mapped 写法
 * （`::ffff:127.0.0.1`），而所有 IPv4 判断都按点分四位写的。不归一化，
 * 回环地址会被当成公网地址显示出来 —— 页面上写着"你的 IP 是 ::ffff:127.0.0.1"，很丢人。
 */
export function normalizeIp(ip: string): string {
  const v = ip.trim().toLowerCase().replace(/^\[|\]$/g, "");
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(v);
  return mapped ? mapped[1] : v;
}

/** 内网 / 回环地址没有国家属性，别拿它去查库。 */
export function isPrivateIp(ip: string): boolean {
  const v = normalizeIp(ip);
  if (!v) return true;
  if (v === "::1" || v === "[::1]" || v === "direct") return true;
  if (/^10\./.test(v) || /^127\./.test(v) || /^0\.0\.0\.0$/.test(v)) return true;
  if (/^192\.168\./.test(v)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(v)) return true;
  if (/^169\.254\./.test(v)) return true; // 云元数据地址
  if (/^f[cd][0-9a-f]{2}:/.test(v) || /^fe80:/.test(v)) return true; // IPv6 ULA / link-local
  return false;
}

/**
 * IP → 区域。只有配了 PROBE_REGION_LOOKUP_URL 才会真的发请求。
 *
 * 约定：URL 里出现 {ip} 就替换，否则把它当前缀拼接（两种写法都常见）。
 * 返回体可以是纯文本国家码，也可以是 JSON（country / country_code / countryCode）。
 * 任何异常一律 null —— 地域判定失败不应该让整条检索链挂掉，它会退回兜底区域。
 */
export async function lookupIpRegion(ip: string): Promise<{ region: Region; country?: string } | null> {
  const tpl = (process.env.PROBE_REGION_LOOKUP_URL ?? "").trim();
  if (!tpl || !ip || isPrivateIp(ip)) return null;
  const url = tpl.includes("{ip}") ? tpl.replace("{ip}", encodeURIComponent(ip)) : tpl + encodeURIComponent(ip);
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(1_500), cache: "no-store" });
    if (!res.ok) return null;
    const text = (await res.text()).slice(0, 300).trim();
    let raw = text;
    try {
      const j = JSON.parse(text) as Record<string, unknown>;
      raw = String(j.country ?? j.country_code ?? j.countryCode ?? j.code ?? "");
    } catch {
      // 纯文本国家码
    }
    const region = regionFromCountry(raw);
    return region ? { region, country: raw.trim().toUpperCase().slice(0, 8) } : null;
  } catch {
    return null;
  }
}

export function defaultRegion(): Region {
  return parseRegionWord(process.env.PROBE_DEFAULT_REGION) ?? "cn";
}

/**
 * 一次请求的区域结论。
 * 只信任 PROBE_TRUSTED_PROXY_HOPS 规定的跳数取到的 IP（与限流同一套），
 * 否则任何人都能用 X-Forwarded-For 把自己伪装成境外用户、绕过出境限制。
 */
export async function resolveRegionForRequest(request: Request): Promise<RegionHit> {
  const mode = parseRegionWord(process.env.PROBE_REGION_MODE);
  if (mode) return { region: mode, source: "mode" };

  const byHeader = regionFromHeaders((name) => request.headers.get(name));
  if (byHeader) return byHeader;

  const ip = clientKey(request);
  if (ip && ip !== "direct") {
    const hit = await lookupIpRegion(ip);
    if (hit) return { region: hit.region, source: "ip", country: hit.country };
  }

  return { region: defaultRegion(), source: "default" };
}
