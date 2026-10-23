/**
 * 语言判定。只做一件事：给定一段文本，判断它是不是中文、要不要翻译。
 * 不用第三方库 —— 来源文本通常是标题 + 摘要，短到语言识别模型也容易翻车。
 */

export type LangCode = "zh" | "en" | "ja" | "ko" | "ru" | "ar" | "unknown";

export const LANG_NAME: Record<LangCode, { zh: string; native: string }> = {
  zh: { zh: "中文", native: "中文" },
  en: { zh: "英语", native: "English" },
  ja: { zh: "日语", native: "日本語" },
  ko: { zh: "韩语", native: "한국어" },
  ru: { zh: "俄语", native: "Русский" },
  ar: { zh: "阿拉伯语", native: "العربية" },
  unknown: { zh: "未识别", native: "unknown" },
};

export function detectLang(text: string): LangCode {
  const s = text.slice(0, 4000);
  let han = 0;
  let latin = 0;
  let kana = 0;
  let hangul = 0;
  let cyrillic = 0;
  let arabic = 0;

  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0;
    if (c >= 0x4e00 && c <= 0x9fff) han++;
    else if (c >= 0x3040 && c <= 0x30ff) kana++;
    else if (c >= 0xac00 && c <= 0xd7af) hangul++;
    else if (c >= 0x0400 && c <= 0x04ff) cyrillic++;
    else if (c >= 0x0600 && c <= 0x06ff) arabic++;
    else if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122)) latin++;
  }

  const total = han + latin + kana + hangul + cyrillic + arabic;
  if (total < 8) return "unknown";
  // 日语里汉字很多，必须先看假名，否则会被判成中文。
  if (kana >= 2 && kana + han > latin) return "ja";
  if (hangul > 3 && hangul > latin * 0.5) return "ko";
  if (cyrillic > latin) return "ru";
  if (arabic > latin) return "ar";
  if (han > 3 && han >= latin * 0.25) return "zh";
  if (latin > 0) return "en";
  return "unknown";
}

/** 目标语言跟着原文走：中文原文翻成英文，其他都翻成中文。 */
/**
 * 对照的目标语言：界面语言是中文，所以一律对齐到中文。
 * 原文本来就是中文时 needsTranslation 为 false —— 把中文报告"翻译"成英文
 * 对读中文的人没有价值，只会多一层机器改写。
 */
export function targetFor(_from: LangCode): LangCode {
  return "zh";
}

export function needsTranslation(from: LangCode, to: LangCode): boolean {
  if (from === "unknown") return false;
  return from !== to;
}

/** MyMemory 用的语言标记。 */
export function memPair(from: LangCode, to: LangCode): string | null {
  const map: Record<string, string> = {
    zh: "zh-CN",
    en: "en",
    ja: "ja",
    ko: "ko",
    ru: "ru",
    ar: "ar",
  };
  const a = map[from];
  const b = map[to];
  if (!a || !b) return null;
  return a + "|" + b;
}
