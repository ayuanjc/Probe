import type { RawSource } from "./schemas";

/**
 * 吻合度的算术层：纯函数，无 IO、无模型、无 zod 运行时依赖。
 *
 * 这里每一个数字都对应一个具体的失败模式，不是"指标越多越专业"：
 *   - effectiveSampleSize：十家转载算十票 → 假共识（Ladha 1992：票相关则 Condorcet 失效）
 *   - fleissKappa / gwetAc1：没有机会校正的一致性会把"世界上只有一种说法"读成"高度一致"
 *   - wilsonInterval：报 100% 而不给区间，是在用样本量伪装确定性
 *   - weightedAgreement：朴素吻合度与有效吻合度的差，本身就是该给用户看的东西
 *   - buildDossierView：七个数字不能平铺，界面只留三个，其余进 tooltip
 */

/** 95% 双侧正态分位。写死常数而不是每次都查表，也避免 Math 的近似漂移。 */
export const Z_95 = 1.959963984540054;

/**
 * 假共识溢价的显示阈值：2 个百分点。
 *
 * 低于这个量级时，差异全部来自"权重四舍五入到一位小数"的显示精度，
 * 高亮它只会训练用户忽略高亮。0.038 那组（文档 §3.3）刚好越过这条线。
 */
export const FAKE_CONSENSUS_EPS = 0.02;

/** 只有转载、没有一手条目的 owner 拿到的权重（文档 §3.2）。 */
export const SYNDICATED_OWNER_WEIGHT = 0.3;

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/**
 * Kish 有效样本量：(Σw)² / Σw²。
 *
 * 全等权重时恰好等于条数（5 条 1.0 → 5），这是它作为"票数"的唯一正当性：
 * 一旦有票被降权，n_eff 立刻小于条数，且永远不可能大于条数。
 * 负权重与非有限值按 0 处理 —— 上游给 NaN 时宁可少算一票，也不让整条链路变 NaN。
 */
export function effectiveSampleSize(weights: readonly number[]): number {
  let sum = 0;
  let sumSq = 0;
  for (const raw of weights) {
    const w = Number.isFinite(raw) && raw > 0 ? raw : 0;
    sum += w;
    sumSq += w * w;
  }
  if (sumSq === 0) return 0;
  return (sum * sum) / sumSq;
}

export type Interval = { low: number; high: number };

/**
 * Wilson 得分区间。不用正态近似（Wald）：比例接近 0 或 1 时 Wald 会给出超过 1
 * 的上界或负的下界，而这里恰恰最常见的就是 3/3、9/10 这种小样本全胜。
 * 实测 3/3 → [0.4385, 1.0000]，与"3 条全支持所以我 100% 确定"是两个故事。
 */
export function wilsonInterval(successes: number, trials: number, z = Z_95): Interval {
  if (!Number.isFinite(trials) || trials <= 0) return { low: 0, high: 1 };
  const n = trials;
  const k = Math.min(Math.max(Number.isFinite(successes) ? successes : 0, 0), n);
  const p = k / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return { low: clamp01(center - half), high: clamp01(center + half) };
}

/**
 * 用「比例 + 有效样本量」直接算区间。
 *
 * 为什么不用原始条数当分母：票之间相关时，真实信息量是 n_eff 而不是条数。
 * 拿条数算会得到虚窄的区间 —— 10 家转载给出 [0.72, 0.98]，看起来板上钉钉，
 * 而 n_eff 只有 1.2 时同一比例应该是 [0.13, 0.96]。区间必须跟着权重一起缩。
 */
export function wilsonFromProportion(p: number, effectiveN: number, z = Z_95): Interval {
  if (!Number.isFinite(effectiveN) || effectiveN <= 0) return { low: 0, high: 1 };
  // Wilson 只吃整数计数，所以先把比例折回「n 票里 k 票」。
  const n = Math.max(1, Math.round(effectiveN));
  const k = Math.min(n, Math.max(0, Math.round(clamp01(p) * n)));
  return wilsonInterval(k, n, z);
}

type Matrix = readonly (readonly number[])[];

/**
 * 计数矩阵的形状校验：格子是非负有限整数、行长一致、**每行被同样多的判定者打满**。
 * 不合法就返回 null —— 让调用方显式挡掉，而不是拿到一个 NaN 混进报告。
 *
 * 这里曾经把「列数」当成判定者数，还要求每行和等于列数 —— 于是任何
 * 「类别数 ≠ 判定者数」的正常输入（两类四判、三类四判）都被判成非法。
 * 判定者数是每行之和，列数只是名义类别数，两者没有理由相等。
 */
function readMatrix(matrix: Matrix): { rows: number[][]; items: number; raters: number } | null {
  if (!Array.isArray(matrix) || matrix.length === 0) return null;
  const width = Array.isArray(matrix[0]) ? matrix[0].length : 0;
  // 至少两类：只有一类时没有可比较的变异，κ 与 AC1 都无定义。
  if (width < 2) return null;
  const rows: number[][] = [];
  let raters = -1;
  for (const row of matrix) {
    if (!Array.isArray(row) || row.length !== width) return null;
    let total = 0;
    for (const cell of row) {
      if (!Number.isFinite(cell) || cell < 0 || !Number.isInteger(cell)) return null;
      total += cell;
    }
    if (raters < 0) raters = total;
    // 每行必须被同样多的判定者打满；缺一格分母就变了。
    else if (total !== raters) return null;
    rows.push([...row]);
  }
  if (raters < 2) return null;
  return { rows, items: rows.length, raters };
}

export type KappaStats = {
  /** 机会校正后的一致性，1 = 完全一致，0 = 与随机无异，负 = 比随机还差。 */
  kappa: number;
  /** 实测一致率。 */
  pObserved: number;
  /** 随机一致率。必须与 kappa 一起显示：类别越偏，它越接近 1，kappa 就越难看。 */
  pExpected: number;
  nItems: number;
  nRaters: number;
};

/**
 * Fleiss κ（1971）：多个判定者、类别无序、每个条目被同样多的判定者打分。
 *
 * 返回 null 而不是 NaN 的两种情形：
 *   - 矩阵不合法（见 readMatrix）；
 *   - P_e = 1，即所有判定者都只用了同一个类别 —— 此时分母为 0，κ 在数学上无定义。
 *     这不是"完美一致"，是"根本没有可比较的变异"，界面必须显示成未知。
 */
export function fleissKappa(matrix: Matrix): KappaStats | null {
  const m = readMatrix(matrix);
  if (!m) return null;
  const { rows, items, raters } = m;

  let pObservedSum = 0;
  const colSum = new Array<number>(raters).fill(0);
  for (const row of rows) {
    let agree = 0;
    for (let j = 0; j < row.length; j++) {
      agree += row[j] * (row[j] - 1);
      colSum[j] += row[j];
    }
    pObservedSum += agree / (raters * (raters - 1));
  }
  const pObserved = pObservedSum / items;

  const total = items * raters;
  let pExpected = 0;
  for (const c of colSum) {
    const p = c / total;
    pExpected += p * p;
  }

  if (Math.abs(1 - pExpected) < 1e-12) return null;
  return {
    kappa: (pObserved - pExpected) / (1 - pExpected),
    pObserved,
    pExpected,
    nItems: items,
    nRaters: raters,
  };
}

export type Ac1Stats = {
  ac1: number;
  pObserved: number;
  /** 不是 Σp²，是 Σp(1-p)/(q-1)：这就是 AC1 与 κ 分歧的全部来源。 */
  pExpected: number;
  nItems: number;
  nRaters: number;
  /** 参与计算的名义类别数（= 矩阵列数）。丢掉没人用的列会虚高 AC1。 */
  categories: number;
};

/**
 * Gwet AC1（2008）：κ 的替代品，专治流行度悖论。
 *
 * 同一组数据（文档 §3.1 的 6×4 矩阵）κ 是 0.25、AC1 是 0.40，差的不是算错：
 * κ 的 P_e 用 Σp²，当某一类占 2/3 时 P_e 被顶到 0.556，几乎把可解释的变异吃光。
 * 报告里两个都给，读者才知道这个分歧是"数据结构"造成的，不是"信源不靠谱"。
 */
export function gwetAc1(matrix: Matrix, categoryCount?: number): Ac1Stats | null {
  const m = readMatrix(matrix);
  if (!m) return null;
  const { rows, items, raters } = m;
  // 默认的类别数取列数（名义量表），不是判定者数 —— 两者相等只是巧合。
  // 允许外部覆盖，是为了多批次共用同一张量表。
  const width = rows[0].length;
  const categories = Math.max(2, categoryCount ?? width);
  if (categories < 2 || categories > width) return null;

  let pObservedSum = 0;
  const colSum = new Array<number>(categories).fill(0);
  for (const row of rows) {
    let agree = 0;
    for (let j = 0; j < row.length; j++) {
      agree += row[j] * (row[j] - 1);
      if (j < categories) colSum[j] += row[j];
    }
    pObservedSum += agree / (raters * (raters - 1));
  }
  const pObserved = pObservedSum / items;

  const total = items * raters;
  let spread = 0;
  for (const c of colSum) {
    const p = c / total;
    spread += p * (1 - p);
  }
  const pExpected = spread / (categories - 1);
  if (Math.abs(1 - pExpected) < 1e-12) return null;

  return {
    ac1: (pObserved - pExpected) / (1 - pExpected),
    pObserved,
    pExpected,
    nItems: items,
    nRaters: raters,
    categories,
  };
}

export type AgreementBreakdown = {
  /** 按条数算的吻合度：支持票 / 总票。 */
  naive: number;
  /** 按 owner 权重算的吻合度：这是界面该显示的那个。 */
  weighted: number;
  /** naive - weighted。> 0 表示赞成方里塞了大量低权（转载）票。 */
  premium: number;
  supportMass: number;
  contraMass: number;
  nSupport: number;
  nContra: number;
  n: number;
};

/**
 * 朴素吻合度、有效吻合度、以及两者的差。
 *
 * 两个口径必须同时算出来，因为差值本身是信息：
 * 5 支持（含 3 条转载，权重 .3/.3/.5）+ 1 反对（一手 .8）
 *   朴素 = 5/6 = 0.833，有效 = 3.1/3.9 = 0.795，溢价 0.038。
 * 只报 0.795 用户学不到东西；只报 0.833 就是在骗人。
 *
 * 一票没有时两个比例都给 0.5（中性），同时 n = 0 —— 调用方必须看 n，
 * 把"没查过"当成"一半相信"是这套指标最容易被误用的地方。
 */
export function weightedAgreement(
  support: readonly number[],
  contradict: readonly number[],
): AgreementBreakdown {
  const mass = (xs: readonly number[]): number => {
    let s = 0;
    for (const x of xs) if (Number.isFinite(x) && x > 0) s += x;
    return s;
  };
  const supportMass = mass(support);
  const contraMass = mass(contradict);
  const nSupport = support.length;
  const nContra = contradict.length;
  const n = nSupport + nContra;
  if (n === 0) {
    return { naive: 0.5, weighted: 0.5, premium: 0, supportMass: 0, contraMass: 0, nSupport: 0, nContra: 0, n: 0 };
  }
  const naive = nSupport / n;
  const denom = supportMass + contraMass;
  const weighted = denom > 0 ? supportMass / denom : naive;
  return { naive, weighted, premium: naive - weighted, supportMass, contraMass, nSupport, nContra, n };
}

export type DossierMetrics = {
  /** 每条支持证据的 owner 权重（一手 1.0 / 转载 0.3 / 留出集以外置 0）。 */
  support: readonly number[];
  contradict: readonly number[];
  /** effectiveOwners().nEff 的结果。 */
  nEff: number;
  /** Fleiss κ；null = 无定义（单类别或判定者不足），界面显示"未计"。 */
  kappa?: number | null;
  /** 与 κ 配套的随机一致率，必须一起展示（流行度悖论）。 */
  kappaExpected?: number | null;
  ac1?: number | null;
  /** 参与判定的断言数。0 表示这一轮没有做核验。 */
  nChecked?: number;
  /** 文档议题面被覆盖的比例；null = 没算。 */
  coverage?: number | null;
  /** 判为 silent（没找到证据）的断言数 —— 沉默不是支持（Noelle-Neumann 1974）。 */
  nSilent?: number;
};

export type DossierView = {
  /**
   * 界面主数字。value 是有效吻合度，low/high 是按 n_eff 算的 Wilson 区间。
   * null = 没有任何核验证据，界面必须显示"未核验"，不能回落到 0.5。
   */
  agreement: { value: number; low: number; high: number; n: number } | null;
  /** 有效独立源数。用户看到的是"相当于几个独立来源"，不是"几个域名"。 */
  nEff: number;
  /** 假共识高亮：只有超过显示阈值且反对票真实存在时才给，否则为 null。 */
  fakeConsensus: {
    premium: number;
    supportMass: number;
    contraMass: number;
    nSupport: number;
    nContra: number;
  } | null;
  /** 其余四个数字。只进 hover tooltip，不平铺在卡片上。 */
  tooltip: {
    naive: number;
    kappa: number | null;
    kappaExpected: number | null;
    ac1: number | null;
    nSupport: number;
    nContra: number;
    nSilent: number;
    nChecked: number;
    coverage: number | null;
    supportMass: number;
    contraMass: number;
  };
};

/** 卡片正文允许出现的字段，其余一律进 tooltip。改这里就等于改 UI 契约。 */
export const DOSSIER_VISIBLE_FIELDS = ["agreement", "nEff", "fakeConsensus"] as const;

/**
 * 把七个数字压成「三个可见 + 五个 tooltip」。
 *
 * 平铺七个数字的后果不是"信息更全"，是用户一个都不读：
 * 界面上并列的等权数字没有主次，读者只会挑那个最小的记住。
 * 所以三个可见项各有明确职责 —— 相信多少（agreement）、有多少独立证据（nEff）、
 * 其中有多少是转载撑起来的（fakeConsensus）；κ 这类内部诊断口径下沉。
 */
export function buildDossierView(m: DossierMetrics): DossierView {
  const breakdown = weightedAgreement(m.support, m.contradict);
  const nEff = Number.isFinite(m.nEff) && m.nEff > 0 ? m.nEff : 0;
  const hasEvidence = breakdown.n > 0 && nEff > 0;

  return {
    agreement: hasEvidence
      ? {
          value: clamp01(breakdown.weighted),
          ...wilsonFromProportion(breakdown.weighted, nEff),
          n: breakdown.n,
        }
      : null,
    nEff,
    fakeConsensus:
      breakdown.nContra >= 1 && breakdown.nSupport >= 3 && breakdown.premium >= FAKE_CONSENSUS_EPS
        ? {
            premium: clamp01(breakdown.premium),
            supportMass: breakdown.supportMass,
            contraMass: breakdown.contraMass,
            nSupport: breakdown.nSupport,
            nContra: breakdown.nContra,
          }
        : null,
    tooltip: {
      naive: breakdown.naive,
      kappa: m.kappa ?? null,
      kappaExpected: m.kappaExpected ?? null,
      ac1: m.ac1 ?? null,
      nSupport: breakdown.nSupport,
      nContra: breakdown.nContra,
      nSilent: m.nSilent ?? 0,
      nChecked: m.nChecked ?? 0,
      coverage: m.coverage ?? null,
      supportMass: breakdown.supportMass,
      contraMass: breakdown.contraMass,
    },
  };
}

/**
 * 把「每个 owner 一手 / 只转载」折成一个权重向量，交给 n_eff。
 *
 * 一个 owner 只占一票，取它最强的那一条：同一家 5 篇一手报道仍然是 1 票
 * （相关性没变），但它不该因为另外 3 篇是转载就连降成 0.3。
 */
export function ownerWeights(
  byOwner: ReadonlyMap<string, { firsthand: boolean }[]>,
): { weights: number[]; distributors: string[] } {
  const weights: number[] = [];
  const distributors: string[] = [];
  for (const [owner, entries] of byOwner) {
    const hasFirsthand = entries.some((e) => e.firsthand);
    weights.push(hasFirsthand ? 1 : SYNDICATED_OWNER_WEIGHT);
    if (!hasFirsthand) distributors.push(owner);
  }
  return { weights, distributors };
}

/** 便利包装：把 RawSource 列表按 owner 分组后算权重。syndicated 用去重前的集合。 */
export function weightsFromSources(
  sources: readonly Pick<RawSource, "id" | "owner" | "url">[],
  ownerOf: (s: Pick<RawSource, "id" | "owner" | "url">) => string,
  syndicated: ReadonlySet<string> | readonly string[],
): { weights: number[]; distributors: string[] } {
  const flagged = new Set<string>(syndicated as Iterable<string>);
  const byOwner = new Map<string, { firsthand: boolean }[]>();
  for (const s of sources) {
    const key = ownerOf(s);
    const list = byOwner.get(key) ?? [];
    list.push({ firsthand: !flagged.has(s.id) });
    byOwner.set(key, list);
  }
  return ownerWeights(byOwner);
}
