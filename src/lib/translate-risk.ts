/**
 * 翻译歧义度：不用模型自评，只用**可以逐条举出来的机械差异**打分。
 *
 * 理由：让模型给自己的译文打"可信度"，它永远会给 0.9。
 * 但"原文里的 37% 在译文里消失了""专名被换掉了""整段没翻"这些是可验证的事实，
 * 每一条都能对着界面指给用户看。
 */

import type { LangCode } from "./lang";

export type RiskBand = "low" | "mid" | "high";

export type RiskSignal = {
  code: string;
  label: string;
  weight: number;
  detail?: string;
};

export type RiskScore = {
  risk: number;
  band: RiskBand;
  signals: RiskSignal[];
};

// 前面不能是字母：Q3 / H200 / GPT-5 里的数字是标识符的一部分，
// 它们"消失"往往是因为被正常译成「第三季度」「9200 芯片」，不算漏译。
const NUMBER_RE = /(?<![A-Za-z0-9])\d+(?:[.,]\d+)*/g;

const HEDGES: { re: RegExp; label: string }[] = [
  { re: /\b(may|might|could|would|should|possibly|perhaps|likely|probably)\b/i, label: "情态/推测" },
  { re: /\b(reportedly|allegedly|apparently|seemingly)\b/i, label: "据称/转述" },
  { re: /\b(according to|sources say|it is said|rumou?r)\b/i, label: "消息源模糊" },
  { re: /\b(expected|projected|estimated|forecast|up to|as much as)\b/i, label: "预估口径" },
  { re: /(据悉|据称|预计|或将|疑似|传闻|据报道|消息人士|有待)/, label: "中文模糊措辞" },
];

const PROPER_STOP = new Set([
  "The","This","That","These","Those","However","But","And","For","From","With","After","Before",
  "When","While","What","Which","Where","Who","Why","How","New","More","Most","Some","Such","Its",
  "Their","Our","Your","His","Her","They","There","Then","Than","Also","Just","Now","Today","Yesterday",
  "Monday","Tuesday","Wednesday","Thursday","Friday","Saturday","Sunday",
  "January","February","March","April","May","June","July","August","September","October","November","December",
]);

/** 技术上允许保留原文的词：品牌、缩写、单位。它们原样出现在译文里不算"没翻"。 */
const KEEP_AS_IS = new Set([
  "AI","API","GPU","CPU","LLM","IPO","CEO","CTO","CFO","HTTP","HTTPS","JSON","SQL","URL","USD","EUR","CNY",
  "GPT","RISC","ARM","X86","USB","SSD","DRAM","NAND","HBM","TSMC","ASML","NVIDIA","OPENAI","GOOGLE","APPLE",
  "MICROSOFT","META","AMAZON","TESLA","SPACEX","AMD","INTEL","QUALCOMM","SAMSUNG","HUAWEI","BYD","TIKTOK",
]);

function digits(text: string): string[] {
  return (text.match(NUMBER_RE) ?? []).map((n) => n.replace(/[.,]/g, "")).filter((n) => n.length > 0);
}

function properNouns(src: string): string[] {
  const out = new Set<string>();
  const re = /\b[A-Z][A-Za-z0-9.&'-]{2,}\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const word = m[0];
    if (PROPER_STOP.has(word)) continue;
    if (KEEP_AS_IS.has(word.toUpperCase())) continue;

    // 句首大写是最常见的假阳性：Analysts / Separately / Meanwhile 都不是专名。
    // 真正的专名通常还会带数字、缩写形状，或在别处出现过；这里按这个判。
    const atSentenceStart = m.index === 0 || /[.!?\n]\s*$/.test(src.slice(0, m.index));
    const looksLikeName = /\d/.test(word) || /[A-Z]{2,}/.test(word) || /[&.]/.test(word);
    if (atSentenceStart && !looksLikeName) continue;
    out.add(word);
  }
  return [...out];
}

export function translationRisk(src: string, dst: string, from: LangCode): RiskScore {
  const signals: RiskSignal[] = [];
  const srcTrim = src.trim();
  const dstTrim = dst.trim();

  if (dstTrim.length === 0) {
    return {
      risk: 1,
      band: "high",
      signals: [{ code: "empty", label: "未产出译文", weight: 1 }],
    };
  }

  // 1) 数字：最硬的证据。原文里的数字在译文里找不到，读者就会读到另一个事实。
  const srcNums = digits(srcTrim);
  const dstNums = new Set(digits(dstTrim));
  const missing = srcNums.filter((n) => !dstNums.has(n));
  if (missing.length > 0) {
    signals.push({
      code: "number_lost",
      label: "数字未对齐",
      weight: Math.min(0.6, 0.35 + 0.1 * missing.length),
      detail: "原文有、译文缺：" + missing.slice(0, 4).join(" / "),
    });
  }

  // 2) 专名：公司/产品/人名被"意译"掉，读者就搜不到原始出处。
  const props = properNouns(srcTrim);
  if (props.length > 0) {
    const dstLower = dstTrim.toLowerCase();
    const lost = props.filter((p) => !dstLower.includes(p.toLowerCase()));
    if (lost.length > 0) {
      signals.push({
        code: "proper_lost",
        label: "专名未保留",
        weight: Math.min(0.4, 0.18 + 0.08 * lost.length),
        detail: lost.slice(0, 4).join(" / "),
      });
    }
  }

  // 3) 未译残留：英译中时，译文里还留着大段英文单词（专名之外）。
  if (from === "en") {
    const keep = new Set(props.map((p) => p.toLowerCase()));
    // 原文里首字母大写的词（Rust / Google / Tuesday）本来就是该保留的写法：
    // 译者把它留在译文里不算"漏译"，正是我们要的。
    const srcCaps = new Set(
      (srcTrim.match(/\b[A-Z][a-z]{2,}\b/g) ?? []).map((w) => w.toLowerCase()),
    );
    const words = (dstTrim.match(/[A-Za-z]{4,}/g) ?? []).filter((w) => {
      const lw = w.toLowerCase();
      if (srcCaps.has(lw)) return false;
      return !keep.has(lw) && !KEEP_AS_IS.has(w.toUpperCase());
    });
    // 单个短词（"href"）多半是抓取残留或专名，不该让整段变黄；
    // 要么残留多处，要么有长串英文，才算没翻。
    const longest = words.reduce((n, w) => Math.max(n, w.length), 0);
    if (words.length < 2 && longest < 8) {
      // 不构成"未译残留"
    } else {
    const chars = words.reduce((n, w) => n + w.length, 0);
    const ratio = chars / Math.max(1, dstTrim.length);
    if (ratio > 0.06) {
      signals.push({
        code: "untranslated",
        label: "存在未译片段",
        weight: Math.min(0.4, 0.16 + ratio * 1.1),
        detail: words.slice(0, 5).join(" / "),
      });
    }
    }
  }

  // 4) 长度比：英译中通常落在 0.25~0.95。明显偏离往往是漏译或自我发挥。
  if (from === "en") {
    const ratio = dstTrim.length / Math.max(1, srcTrim.length);
    if (ratio < 0.22 || ratio > 1.05) {
      signals.push({
        code: "length_skew",
        label: "篇幅比例异常",
        weight: 0.2,
        detail: "译文/原文 = " + ratio.toFixed(2),
      });
    }
  }

  // 5) 原文本身就不确定：这类词翻得再准，读者也会误读成确定结论。
  const hits: string[] = [];
  for (const h of HEDGES) {
    if (h.re.test(srcTrim)) hits.push(h.label);
  }
  if (hits.length > 0) {
    signals.push({
      code: "hedge",
      label: "原文含不确定措辞",
      weight: Math.min(0.3, 0.15 + 0.07 * hits.length),
      detail: [...new Set(hits)].join(" / "),
    });
  }

  // 独立信号按"至少一条成立"累计：1 − Π(1 − w)，避免简单相加爆顶。
  const risk = 1 - signals.reduce((acc, s) => acc * (1 - s.weight), 1);
  return { risk: Math.round(clamp01(risk) * 100) / 100, band: band(risk), signals };
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

function band(risk: number): RiskBand {
  if (risk < 0.3) return "low";
  if (risk < 0.6) return "mid";
  return "high";
}

export function overallRisk(scores: RiskScore[]): RiskScore {
  if (scores.length === 0) return { risk: 0, band: "low", signals: [] };
  const risk = scores.reduce((a, s) => a + s.risk, 0) / scores.length;
  const seen = new Set<string>();
  const signals: RiskSignal[] = [];
  for (const s of scores) {
    for (const sig of s.signals) {
      if (seen.has(sig.code)) continue;
      seen.add(sig.code);
      signals.push(sig);
    }
  }
  return { risk: Math.round(risk * 100) / 100, band: band(risk), signals };
}
