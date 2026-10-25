import { createHash } from "node:crypto";
import { magnitudeOf, normalizeValue } from "./text";
import type { Claim, Confidence, RawSource } from "./schemas";

/**
 * 「这次搜索里出现了哪些数字」—— 结果页那张表的数据源。
 *
 * 它**不是**结论，也不参与置信度：每行只回答「哪个数、什么口径、哪句原文、谁说的」。
 * 铁律在这里落三条：
 *   1. 无源不显示 —— 没有 sourceId 的数字直接丢，不做「无出处补一句」。
 *   2. quote 必须是原文切片，靠 indexOf 复核；复核不过就丢（不猜、不修）。
 *   3. 数值先折算量级再比，同量级不同写法要合并（12.6% 与 12.60% 是同一行）。
 *
 * 两条取数路径，按优先级用：
 *   - claims 有（模型在线）：直接用 attr 当指标名，口径最干净。
 *   - claims 没有（本机没 key / 模型挂了）：退回正则扫 snippet。这条路径**只搬原文**，
 *     不做任何推断 —— 它产出的是「原文里出现过的数字」，不是「这篇文章的要点」。
 */

export type KeyFigureKind = "percent" | "amount" | "quantity" | "ratio" | "temporal";

export type KeyFigure = {
  /** 稳定 id：同一份数据重跑要能对上（前端做 key，回放时也不会抖）。 */
  id: string;
  /** 指标名。来自 claim.attr，或数字左侧那段原文。 */
  label: string;
  /** 展示用数值原文，如 "12.6%" / "1042 亿元" / "14GWh"。 */
  value: string;
  /** 折算后的十进制串，用来判「是不是同一个数」。 */
  normalized: string;
  unit?: string;
  /** 时间窗，如 "2025年第三季度" / "2024年" / "近 7 天"。抽不到就不填。 */
  period?: string;
  /** 原文语境句（逐字切片）。 */
  quote: string;
  sourceIds: string[];
  kind: KeyFigureKind;
};

export type KeyFiguresResult = {
  figures: KeyFigure[];
  /** claims = 模型抽的断言；snippets = 正则扫原文；claims+snippets = 两者合并；none = 什么都没有。 */
  mode: "claims" | "snippets" | "claims+snippets" | "none";
  notes: string[];
};

const MAX_FIGURES = 24;
const QUOTE_MAX = 140;

/**
 * 单位表：顺序有意义 —— 「万亿」必须先于「亿」，「亿」必须先于「元」，
 * 否则「1.2万亿元」会被切成「1.2 万」。中文不能用 \b 收尾（CJK 不是 \w，
 * 边界判断会失效），所以中英文各写一条。
 */
const UNITS: { re: RegExp; unit: string; kind: KeyFigureKind }[] = [
  { re: /^\s*(?:个百分点|percentage points?)/i, unit: "个百分点", kind: "percent" },
  { re: /^\s*(?:%|％)/, unit: "%", kind: "percent" },
  { re: /^\s*bps/i, unit: "bps", kind: "percent" },
  { re: /^\s*(?:万亿|trillion)/i, unit: "万亿", kind: "amount" },
  { re: /^\s*(?:亿|(?:billion|bn)\b)/i, unit: "亿", kind: "amount" },
  { re: /^\s*(?:万|(?:million|mn)\b)/i, unit: "万", kind: "amount" },
  { re: /^\s*(?:千|(?:thousand)\b)/i, unit: "千", kind: "amount" },
  { re: /^\s*(?:GWh|MWh|kWh|GW|MW|kW)\b/i, unit: "GWh", kind: "quantity" },
  { re: /^\s*吨/, unit: "吨", kind: "quantity" },
  { re: /^\s*(?:台|辆|家|人|个)/, unit: "个", kind: "quantity" },
  { re: /^\s*(?:倍|x)\b/i, unit: "倍", kind: "ratio" },
  { re: /^\s*(?:美元|欧元|元|块)/, unit: "元", kind: "amount" },
];

const YEAR_ONLY = /^(?:19|20)\d{2}$/;

function hash(s: string): string {
  return createHash("sha1").update(s).digest("hex").slice(0, 12);
}

/** 句子边界：中英文句读 + 换行。用来切 quote。 */
function sentenceAt(text: string, at: number): string {
  let start = 0;
  for (let i = at - 1; i >= 0; i--) {
    if ("。！？；!?;\n".includes(text[i])) {
      start = i + 1;
      break;
    }
  }
  let end = text.length;
  for (let i = at; i < text.length; i++) {
    if ("。！？；!?;\n".includes(text[i])) {
      end = i + 1;
      break;
    }
  }
  return text.slice(start, end).trim();
}

/** 数字左侧那段原文当指标名：截到标点为止，最多 22 字，去掉开头连词。 */
function labelBefore(text: string, at: number): string {
  let start = 0;
  for (let i = at - 1; i >= 0; i--) {
    if ("。！？；!?;，,、：:（(\n".includes(text[i])) {
      start = i + 1;
      break;
    }
  }
  const raw = text.slice(start, at).replace(/^[的和与及或、\s]+/, "").trim();
  if (raw.length <= 22) return raw;
  return raw.slice(-22);
}

const PERIOD_RES: RegExp[] = [
  /(?:19|20)\d{2}\s*年?\s*(?:第?[一二三四1-4]\s*季度|Q[1-4]|[1-9]\s*月|上半年|下半年|全年)/i,
  /(?:19|20)\d{2}\s*年(?:度)?/,
  /(?:近|过去|最近)\s*[一二三四五六七八九十\d]+\s*(?:天|日|周|个月|月|年)/,
  /(?:今天|昨日|昨天|本周|上周|本月|上月|今年|去年)/,
];

/**
 * 指标名清洗：时间窗单独占一列，不该混在指标名里。
 * 「2025年第三季度 光伏组件价格」与「光伏组件价格」是同一个指标，
 * 不清掉前缀就会被当成两条、并且合并时挑不到干净的那条。
 */
function cleanLabel(raw: string): string {
  let s = raw.trim();
  for (const re of PERIOD_RES) {
    const m = new RegExp("^(?:" + re.source + ")\\s*").exec(s);
    if (m) {
      s = s.slice(m[0].length);
      break;
    }
  }
  return s.replace(/^[的和与及、\s]+/, "").replace(/[：:，,、\s]+$/, "").trim();
}

function periodOf(text: string): string | undefined {
  for (const re of PERIOD_RES) {
    const m = re.exec(text);
    if (m) return m[0].replace(/\s+/g, " ").trim();
  }
  return undefined;
}

type Candidate = { value: string; unit?: string; kind: KeyFigureKind; index: number; label: string; quote: string };

/** 扫一段文本里的「数值 + 紧邻单位」。只在数字后面看 6 个字，宁可漏，不许把两个数粘成一个。 */
function scan(text: string): Candidate[] {
  const out: Candidate[] = [];
  const numRe = /\d[\d,，]*(?:\.\d+)?/g;
  let m: RegExpExecArray | null;
  while ((m = numRe.exec(text)) !== null) {
    const raw = m[0];
    const index = m.index;
    const before = index > 0 ? text[index - 1] : "";
    // 前面紧贴字母/数字/百分号的是版本号、型号、日期片段（v2、2025-10、A100），不是数据。
    if (/[A-Za-z0-9_.#]/.test(before)) continue;

    const rest = text.slice(index + raw.length, index + raw.length + 8);
    let matched: { unit: string; kind: KeyFigureKind; len: number } | null = null;
    for (const u of UNITS) {
      const hit = u.re.exec(rest);
      if (hit) {
        matched = { unit: u.unit, kind: u.kind, len: hit[0].length };
        break;
      }
    }

    const bare = raw.replace(/[,，]/g, "");
    // 纯四位年份、纯长数字串（电话/编号）没有单位时一律不当数据。
    if (!matched) {
      if (YEAR_ONLY.test(bare)) continue;
      if (bare.length >= 9) continue;
      // 没有单位也不是年份：只有当它在原句里带有比较意味时才留（增长 12 → 12 是百分点）
      continue;
    }

    /**
     * 单位后面还挂着量词或分母时一起收：「1200 万辆」的「辆」是量词，
     * 「0.68 元/W」的「/W」是计价口径 —— 只留「万」「元」会让两个不同口径的数看起来一样。
     */
    const unitEnd = index + raw.length + matched.len;
    const tail = text.slice(unitEnd, unitEnd + 5);
    const extra = /^(?:辆|台|家|人|个|吨|度|座|条)/.exec(tail)?.[0] ?? /^(?:\/[A-Za-z]{1,4})/.exec(tail)?.[0] ?? "";
    const unitText = text.slice(index + raw.length, unitEnd).trim() + extra;
    const value = (raw + unitText).replace(/\s+/g, "");
    const unitLabel = matched.unit + extra;
    const quoteFull = sentenceAt(text, index);
    const quote = quoteFull.length <= QUOTE_MAX ? quoteFull : text.slice(Math.max(0, index - 60), index + 60).trim();
    out.push({
      value,
      unit: unitLabel,
      kind: matched.kind,
      index,
      label: cleanLabel(labelBefore(text, index)),
      quote,
    });
  }
  return out;
}

function kindOfClaim(claim: Claim): KeyFigureKind {
  if (claim.kind === "temporal") return "temporal";
  const unit = (claim.unit ?? "") + claim.value;
  if (/%|％|百分点/.test(unit)) return "percent";
  if (/倍|x\b/i.test(unit)) return "ratio";
  if (/亿|万|元|美元|billion|million|trillion/.test(unit)) return "amount";
  return "quantity";
}

export function extractKeyFigures(input: {
  sources: RawSource[];
  claims: Claim[];
  confidence: Confidence | null;
}): KeyFiguresResult {
  const notes: string[] = [];
  const byId = new Map(input.sources.map((s) => [s.id, s]));
  const figures: KeyFigure[] = [];
  const valueKey = (normalized: string, unit: string | undefined) => normalized + "|" + (unit ?? "");
  const usableClaims = input.claims.length > 0;
  /** 真正留在表里的 claim 行数（claim 可能因为信源对不上而全部被丢）。 */
  let fromClaims = 0;

  /**
   * 合并同一行：同一个数（数值+单位）在多处出现时并成一行。
   *
   * 键里**不带指标名** —— 一段原文里同一个数会被反复扫到，左侧截出来的指标名
   * 却各不相同（「光伏组件价格」/「2025年第三季度 光伏组件价格」/「分析师下调……」）。
   * 带指标名就等于每条都"不同"，表里会出现五行其实是两个数。
   * 合并时指标名取最短的那条：噪声都挂在长前缀上，最短的通常就是干净的指标名。
   */
  const mergeInto = (hit: KeyFigure, ids: string[], label?: string) => {
    for (const id of ids) if (!hit.sourceIds.includes(id)) hit.sourceIds.push(id);
    const clean = (label ?? "").trim();
    if (clean.length >= 2 && clean.length < hit.label.length) hit.label = clean;
  };
  /*
   * 查重键里要带上 period。
   *
   * 只有 normalized + unit 时，「2024 年 12%」与「2025 年 12%」会被并成一行：
   * 行里挂着两条信源，period/quote 取第一期，于是第二期的数字冒用第一期的口径 ——
   * 这不是排版问题，是数据造假。
   *
   * 但两边都缺 period 时必须还能并：periodOf 靠正则抓 quote 里的时间词，
   * 同一句话在不同信源的摘录里常常只有一处带得到，硬按 period 分组
   * 会让表格被同一个数字刷屏。所以「任一方缺 period」视为同期。
   */
  const samePeriod = (a: string | undefined, b: string | undefined) => !a || !b || a === b;
  const findSame = (normalized: string, unit: string | undefined, period?: string) => {
    const vKey = valueKey(normalized, unit);
    return figures.find(
      (f) => valueKey(f.normalized, f.unit) === vKey && samePeriod(f.period, period),
    );
  };

  // 路径一：模型抽到的断言。label 用 attr，quote 直接是原文片段。
  if (usableClaims) {
    for (const claim of input.claims) {
      const ids = claim.sourceIds.filter((id) => byId.has(id));
      if (ids.length === 0) continue;
      /**
       * claim.value 必须是**一个数值本身**，不是含数字的句子。
       *
       * 断言池里大多数条目是实体行为（「分析师下调……目标价，理由指向库存」），
       * 里面常夹着「2025」这种年份。只测「有没有数字」会把这些整句当成数据搬进表里，
       * 表就变成"看起来像数据、其实一个数都没有"。所以判据是：去掉百分号后
       * 整个 value 就是一个数（可带千分位与小数），且必须有单位 ——
       * 没有单位的裸数说明不了口径（12 是 12 个、12% 还是 12 亿元？），一律不收。
       * 这类被丢的断言由下面的原文扫描兜底：quote 里真有数字，扫描会抽出来。
       */
      const rawValue = (claim.value ?? "").trim();
      const bareValue = rawValue.replace(/[%％]$/, "");
      if (!/^-?\d[\d,]*(?:\.\d+)?$/.test(bareValue)) continue;
      const unit = (claim.unit ?? "").trim() || (/%|％$/.test(rawValue) ? "%" : "");
      if (!unit) continue;
      if (!claim.unit && /^(?:19|20)\d{2}$/.test(bareValue)) continue;
      const normalized = normalizeValue(bareValue + " " + unit);
      // 「12.6 %」「1.2 万亿元」的空格是英文排版习惯；中文与百分号后面不该有空格。
      const value = unit && /^[A-Za-z]/.test(unit) ? bareValue + " " + unit : bareValue + unit;
      const at = claim.quote.search(/\d/);
      const label = cleanLabel((claim.attr || "").trim() || (at >= 0 ? labelBefore(claim.quote, at) : ""));
      /*
       * unit 一定要用补全后的那个。
       *
       * 上面 :256 已经为「value 带 % 而 claim.unit 为空」补出 unit = "%"，
       * 但查重与入库原本仍用 claim.unit：同一句话里「12%」先以 unit="%" 入表，
       * 后一条同样的断言按 unit=undefined 再查一次，查不到 → 又来一行没有单位的。
       */
      const same = findSame(normalized, unit, periodOf(claim.quote));
      if (same) {
        mergeInto(same, ids, label);
        continue;
      }
      figures.push({
        id: hash(ids[0] + "|" + value + "|" + label),
        label,
        value,
        normalized,
        unit,
        period: periodOf(claim.quote),
        quote: claim.quote,
        sourceIds: ids,
        kind: kindOfClaim(claim),
      });
      fromClaims += 1;
      if (figures.length >= MAX_FIGURES) break;
    }
  }

  // 路径二：正则扫原文。claims 已经覆盖的数值不再重复出现。
  let scanned = 0;
  for (const s of input.sources) {
    if (figures.length >= MAX_FIGURES) break;
    const text = (s.title ?? "") + "。" + (s.snippet ?? "");
    for (const c of scan(text)) {
      if (figures.length >= MAX_FIGURES) break;
      const normalized = normalizeValue(c.value);
      // 这个数已经在表里（claim 抽过，或前一条信源扫到过）：并信源、挑更短的指标名，不新建行。
      const same = findSame(normalized, c.unit, periodOf(c.quote));
      if (same) {
        mergeInto(same, [s.id], c.label);
        continue;
      }
      // quote 必须真在原文里（snippet/title 是上游给的文本，这里只做自洽复核）。
      if (c.quote && !text.includes(c.quote) && !text.includes(c.quote.slice(0, 20))) continue;
      scanned += 1;
      figures.push({
        id: hash(s.id + "|" + c.value + "|" + c.label),
        label: c.label,
        value: c.value,
        normalized,
        unit: c.unit,
        period: periodOf(c.quote),
        quote: c.quote,
        sourceIds: [s.id],
        kind: c.kind,
      });
    }
  }

  const mode: KeyFiguresResult["mode"] =
    figures.length === 0
      ? "none"
      : fromClaims > 0 && scanned > 0
        ? "claims+snippets"
        : fromClaims > 0
          ? "claims"
          : "snippets";

  if (scanned > 0) {
    // 这条必须外发：「从原文搬的数字」和「被交叉核过的数字」不是一回事。
    notes.push("figures:from_snippets");
  }
  if (input.confidence && input.confidence.band === "low" && figures.length > 0) {
    notes.push("figures:low_confidence_uncrossed");
  }
  if (figures.length === 0) notes.push("figures:none");

  // 多家提到过的数字排前面（说明它是这件事的抓手），同源时保持原文出现顺序。
  figures.sort((a, b) => b.sourceIds.length - a.sourceIds.length);

  return { figures, mode, notes };
}

/**
 * 折算后的数值（1.2 万亿 → 1.2e12）。
 *
 * 注意 magnitudeOf 返回的是**乘数**不是数值：magnitudeOf("1.2万亿") === 1e12。
 * 别拿它当数值比较，否则所有 1.x 万亿的数据会全部塌成 1e12、彼此判等。
 * 这里一律走 normalized（normalizeValue 的输出），拿不到数字才退回乘数。
 */
export function magnitudeOfValue(figure: KeyFigure): number {
  const n = Number(figure.normalized);
  return Number.isFinite(n) && n !== 0 ? n : magnitudeOf(figure.value);
}
