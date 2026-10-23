/** 文本归一与相似度工具。没有外部依赖，离线可算。 */

export function normalizeText(s: string): string {
  return s
    .toLowerCase()
    .replace(/[\s\u3000]+/g, " ")
    .replace(/[^\p{L}\p{N} ]/gu, "")
    .trim();
}

/** 英文按词、中文按 bigram 切分，得到一个可做 Jaccard 的 token 集合。 */
export function tokenize(s: string): Set<string> {
  const norm = normalizeText(s);
  const tokens = new Set<string>();
  const words = norm.split(" ").filter(Boolean);
  for (const w of words) {
    if (/^[a-z0-9]+$/.test(w)) {
      tokens.add(w);
      continue;
    }
    const chars = [...w];
    if (chars.length === 1) {
      tokens.add(w);
      continue;
    }
    for (let i = 0; i < chars.length - 1; i++) {
      tokens.add(chars[i] + chars[i + 1]);
    }
  }
  return tokens;
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

export function titleSimilarity(a: string, b: string): number {
  return jaccard(tokenize(a), tokenize(b));
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "unknown";
  }
}

/** 数值归一：去掉千分位、货币符号、百分号后保留数字。 */
export function normalizeValue(raw: string): string {
  const trimmed = raw.trim().toLowerCase();
  const num = trimmed.replace(/[,，\s]/g, "").match(/-?\d+(\.\d+)?/);
  if (num) return num[0];
  return trimmed.replace(/\s+/g, " ");
}
