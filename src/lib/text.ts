/** 文本归一与相似度工具。没有外部依赖，离线可算。 */

export function normalizeText(s: string): string {
  return s
    .toLowerCase()
    .replace(/[\s\u3000]+/g, " ")
    .replace(/[^\p{L}\p{N} ]/gu, "")
    .trim();
}

/**
 * 英文按词、中日韩按 bigram 切分，得到一个可做 Jaccard 的 token 集合。
 *
 * 中文的 bigram 必须在**去掉空格之后**切：「华为发布新机」与「华为 发布 新机」
 * 是同一句话的两种写法，按空格先切词会得到 {华为,发布,新机} 与
 * {华为,为发,发布,布新,新机} 两个几乎不相交的集合，Jaccard 只有 0.43 ——
 * 去重与转载检测会同时漏判。所以 ASCII 词各自成 token，其余字符拼成一条再切。
 */
export function tokenize(s: string): Set<string> {
  const norm = normalizeText(s);
  const tokens = new Set<string>();
  let cjk = "";
  for (const w of norm.split(" ")) {
    if (!w) continue;
    if (/^[a-z0-9]+$/.test(w)) {
      tokens.add(w);
      continue;
    }
    cjk += w;
  }
  const chars = [...cjk];
  if (chars.length === 1) tokens.add(chars[0]);
  for (let i = 0; i + 1 < chars.length; i++) tokens.add(chars[i] + chars[i + 1]);
  return tokens;
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  // 两边都空不是"完全一致"，是"没有可比的内容"。返回 1 会让空标题互相吞并。
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

export function titleSimilarity(a: string, b: string): number {
  return jaccard(tokenize(a), tokenize(b));
}

/** 二级后缀：这些域名要保留三段，否则 co.uk 会被剥成 uk，把所有英国站并成一家。 */
const SECOND_LEVEL = new Set([
  "co.uk", "org.uk", "ac.uk", "com.cn", "net.cn", "org.cn", "gov.cn",
  "com.au", "net.au", "co.jp", "co.kr", "com.br", "com.hk", "com.tw",
  "com.sg", "co.in", "com.mx", "co.nz",
]);

/**
 * owner 归一：取 eTLD+1，而不是只剥 www.。
 * news.x.com / amp.x.com / m.x.com 是同一家媒体，只剥 www. 会把一家算成三家，
 * 独立性（0.35 权重）直接被域名前缀抬起来。解析失败时保留原串，不并成 "unknown"
 * —— 把所有坏 URL 归成同一家比算不出来更失真。
 */
export function hostOf(url: string): string {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return url.trim().toLowerCase() || "unknown";
  }
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":")) return host;
  const parts = host.split(".");
  if (parts.length <= 2) return host;
  const last2 = parts.slice(-2).join(".");
  if (SECOND_LEVEL.has(last2)) return parts.slice(-3).join(".");
  return last2;
}

/** 数量级后缀：不折算的话「3.2 billion」与「3.2」都压成 3.2，三个数量级被当成同一个数。 */
// 故意导出：核验层比较「数字是否一致」时必须用同一份数量级口径，
// 复刻一份的结果是两套口径某天分行，而那种 bug 表现为「一致/冲突」整体反相。
export function magnitudeOf(s: string): number {
  // 中文刻度与英文刻度不是一一对应：亿 = 1e8，而 billion = 1e9；千万 = 1e7，million = 1e6。
  if (/万亿|trillion/.test(s)) return 1e12;
  if (/千万/.test(s)) return 1e7;
  if (/百万/.test(s)) return 1e6;
  if (/亿/.test(s)) return 1e8;
  if (/万/.test(s)) return 1e4;
  if (/千/.test(s)) return 1e3;
  if (/billion|bn\b/.test(s)) return 1e9;
  if (/million|mn\b/.test(s)) return 1e6;
  if (/thousand/.test(s)) return 1e3;
  if (/(^|[^a-z])k\b/.test(s)) return 1e3;
  if (/(^|[^a-z])m\b/.test(s)) return 1e6;
  if (/(^|[^a-z])b\b/.test(s)) return 1e9;
  return 1;
}


/**
 * 数值归一：去掉千分位、货币符号、百分号，并把「万/亿/百万/billion/K/M/B」折进数值。
 * 输出的是折算后的十进制串（3.2 billion → "3200000000"），所以同量级不同写法能对上，
 * 不同量级不会被当成一致。
 */
export function normalizeValue(raw: string): string {
  const trimmed = raw.trim().toLowerCase();
  const num = trimmed.replace(/[,，\s]/g, "").match(/-?\d+(\.\d+)?/);
  if (!num) return trimmed.replace(/\s+/g, " ");
  const n = Number(num[0]);
  if (!Number.isFinite(n)) return num[0];
  const scaled = n * magnitudeOf(trimmed);
  // toPrecision 剪掉 3.2 * 1e9 这类浮点尾数，再转回数字去掉多余的 0。
  return String(Number(scaled.toPrecision(12)));
}
