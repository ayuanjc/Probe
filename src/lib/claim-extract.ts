/**
 * 抽取结果的**服务端复核**：模型给的 quote 到底在不在原文里、值的数字对不对得上。
 *
 * 为什么必须复核：模型编 quote 是最常见的失败模式，而且编得很像 —— 语气、术语、
 * 数字量级都对，只有一个字或一个百分号不同。这类 quote 一旦落库，界面上「点击回到原文」
 * 就会跳到一段对不上的文字，或者更糟：高亮到正确位置，但内容与断言不符。
 *
 * 复核只看**文本本身**，不看模型说了什么 —— 于是这里全是纯函数，可单测、可复现。
 */

import { ClaimKindSchema, type ClaimKind } from "./schemas";

/** 复核失败的原因码。界面与 degraded 都直接用它，不再翻译成第二套词。 */
export type QuoteRejectCode = "quote_short" | "quote_miss" | "value_mismatch" | "kind_invalid" | "attr_empty";

/** quote 太短就没有复核价值：三五个字的片段在任何文章里都能命中，等于没有定位。 */
export const MIN_QUOTE_CHARS = 6;

function squash(s: string): string {
  return (s || "").replace(/\s+/g, " ").trim();
}

/** 全角 → 半角：只折 1 对 1 的字符，这样归一化串的下标能直接映射回原文。 */
const FOLD: Record<string, string> = {
  "，": ",",
  "、": ",",
  "：": ":",
  "；": ";",
  "％": "%",
  "（": "(",
  "）": ")",
  "“": "\"",
  "”": "\"",
  "‘": "\'",
  "’": "\'",
  "－": "-",
  "—": "-",
  "–": "-",
  "　": " ",
};

/** 一串十进制数字（去掉千分位）。用于「值里的数字在 quote 里出现过吗」。 */
export function digitsOf(s: string): string[] {
  const out: string[] = [];
  const re = /\d[\d,]*(?:\.\d+)?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s || "")) !== null) {
    const raw = m[0].replace(/,/g, "");
    if (raw) out.push(raw);
  }
  return out;
}

export type LocatedQuote = { charStart: number; charEnd: number };

/**
 * 在段落里定位 quote，返回**原文坐标系**里的半开区间 [charStart, charEnd)。
 *
 * 做法：先把原文按「去空白 + 全角折半角」归一化，同时建一张「归一化下标 → 原文下标表」，
 * 再在归一化串上 indexOf。命中后靠表回推原文区间。找不到就返回 null，**不模糊匹配**：
 * 猜出来的偏移会让「点击回到原文」跳到别处，那比不跳更糟（用户会以为是文章被改过）。
 *
 * quote 同样先归一化再查，所以模型把「，」写成「,」、把换行重排都不会失配。
 *
 * offset 是该段落在全文里的起点：调用方要全文坐标时传它，段落坐标传 0。
 */
export function locateQuote(segmentText: string, quote: string, offset = 0): LocatedQuote | null {
  const text = segmentText || "";
  const q = normalize(quote);
  if (!text || q.length < MIN_QUOTE_CHARS) return null;

  const { built, map } = normalizeWithMap(text);
  const at = built.indexOf(q);
  if (at < 0) return null;
  const start = map[at];
  const lastMapped = map[at + q.length - 1];
  if (start === undefined || lastMapped === undefined) return null;
  return { charStart: offset + start, charEnd: offset + lastMapped + 1 };
}

/** 归一化：折全角、压空白。用于 quote 与原文比较的同一口径。 */
export function normalize(s: string): string {
  return normalizeWithMap(s || "").built;
}

/**
 * 归一化并保留下标映射：map[i] 是归一化串第 i 个字符来自原文的下标。
 *
 * **空白一律丢弃**，不折叠成一个空格。理由：模型抄 quote 时对换行与空格的处置
 * 全靠猜（原文段尾换行、多个空格、中英文之间的空隙），而空白对「这句话在不在原文里」
 * 没有任何判别力。折叠的话，「……带动。\n\n公司同时宣布」这种跨段 quote 就永远匹配不上，
 * 而它恰恰是最该被定位到的那一类。代价是中英之间的空格也一并忽略（"data center"
 * 与 "datacenter" 会互相命中），这个代价接受得起：错判成命中的后果是「高亮位置正确但
 * 少一个空格」，而不是「高亮到别的句子」。
 */
function normalizeWithMap(text: string): { built: string; map: number[] } {
  const map: number[] = [];
  let built = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (/\s/.test(ch)) continue;
    built += FOLD[ch] ?? ch;
    map.push(i);
  }
  return { built, map };
}

/** 模型可能返回的自由字段（脏的）：只声明我们真会读的那几个。 */
export type RawExtractedClaim = {
  quote?: unknown;
  attr?: unknown;
  value?: unknown;
  unit?: unknown;
  kind?: unknown;
};

export type VerifiedClaim = {
  quote: string;
  attr: string;
  value: string;
  unit?: string;
  kind: ClaimKind;
  /** 全文坐标（调用方把段落起点作为 offset 传进来时）。 */
  charStart: number;
  charEnd: number;
};

export type ClaimCheck =
  | { ok: true; claim: VerifiedClaim }
  | { ok: false; code: QuoteRejectCode };

function str(v: unknown, max = 200): string {
  return typeof v === "string" ? squash(v).slice(0, max) : "";
}

/**
 * 复核一条抽取值。四条规则，按「最可能是模型编造」的顺序检查：
 *
 *   1. quote 太短 → quote_short（不是编造，但没有定位价值）；
 *   2. quote 在原文里找不到 → quote_miss（**编造**，最重要的一条）；
 *   3. quantitative / temporal 断言里的数字没在 quote 里出现 → value_mismatch
 *      （数字被改写：32 亿 写成 23 亿，或把「同比 12%」写成「环比 12%」）；
 *   4. kind 不在取值表里 → kind_invalid（不猜，直接丢）。
 *
 * 归属类与存在性不查数字：它们的 value 是人名/机构/功能名，数字校验只会误伤。
 */
export function verifyExtractedClaim(
  segmentText: string,
  raw: RawExtractedClaim,
  offset = 0,
): ClaimCheck {
  const quote = str(raw.quote, 400);
  const attr = str(raw.attr, 60);
  const value = str(raw.value, 120);
  const unit = str(raw.unit, 24);

  if (quote.length < MIN_QUOTE_CHARS) return { ok: false, code: "quote_short" };
  if (!attr) return { ok: false, code: "attr_empty" };
  if (!value) return { ok: false, code: "attr_empty" };

  const kindParsed = ClaimKindSchema.safeParse(raw.kind);
  if (!kindParsed.success) return { ok: false, code: "kind_invalid" };
  const kind = kindParsed.data;

  const loc = locateQuote(segmentText, quote, offset);
  if (!loc) return { ok: false, code: "quote_miss" };

  if (kind === "quantitative" || kind === "temporal") {
    const want = digitsOf(value + (unit ? " " + unit : ""));
    if (want.length > 0) {
      const have = new Set(digitsOf(quote));
      // 只要有一个数字对不上就判疑似改写：宁可漏掉一条，不可留下一条数字错的。
      if (!want.every((d) => have.has(d))) return { ok: false, code: "value_mismatch" };
    }
    if (kind === "temporal" && want.length === 0) return { ok: false, code: "value_mismatch" };
  }

  return {
    ok: true,
    claim: {
      quote,
      attr,
      value,
      unit: unit || undefined,
      kind,
      charStart: loc.charStart,
      charEnd: loc.charEnd,
    },
  };
}