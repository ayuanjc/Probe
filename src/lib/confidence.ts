import type { Confidence, Claim, RawSource } from "./schemas";
import { hostOf, normalizeValue, titleSimilarity } from "./text";

/**
 * 置信度 = 0.40 * 一手性 + 0.35 * 独立性 + 0.25 * 一致性（PRD 2.2）
 *
 * 为什么不是“NAS 收敛度”：收敛度高只说明信源之间说法一致，十家媒体转载同一篇
 * 通稿即可满分（假共识）。独立性先把 owner 归并，一手性识别转载，一致性只作辅助。
 */

export const WEIGHTS = { firstHand: 0.4, independence: 0.35, consistency: 0.25 } as const;

export function ownerOf(s: RawSource): string {
  return (s.owner || hostOf(s.url)).toLowerCase();
}

/** I = 1 - e^(-n/3)：1 个 owner 得 0.28，3 个得 0.63，6 个得 0.86，之后饱和。 */
export function independenceScore(nOwners: number): number {
  if (nOwners <= 0) return 0;
  return 1 - Math.exp(-nOwners / 3);
}

/**
 * 转载判定：canonical 相同，或标题相似度 > 0.90，或（晚于首条 > 6h 且标题相似 > 0.80）。
 * 同一 owner 内部不算转载（那是同一家自己的多篇），只影响 owner 计数。
 */
export function findSyndicatedIds(sources: RawSource[]): Set<string> {
  /**
   * 排序键要防不可解析的时间：date - date = NaN 时比较器既不正也不负，
   * 排序退化成"数组原样"，后面的 gapHours 也变 NaN，那条「晚 >6h 且相似」的转载规则就静默失效了。
   * 没时间的排到最后，与 retrieve.ts「保留无时间条目」的取舍保持一致。
   */
  const ts = (s: string): number => {
    const t = Date.parse(s);
    return Number.isNaN(t) ? Infinity : t;
  };
  const order = [...sources].sort((a, b) => ts(a.publishedAt) - ts(b.publishedAt));
  const syndicated = new Set<string>();
  const canonicalSeen = new Set<string>();

  for (let i = 0; i < order.length; i++) {
    const cur = order[i];
    if (cur.canonical && canonicalSeen.has(cur.canonical)) {
      syndicated.add(cur.id);
      continue;
    }
    if (cur.canonical) canonicalSeen.add(cur.canonical);

    for (let j = 0; j < i; j++) {
      const prev = order[j];
      if (ownerOf(prev) === ownerOf(cur)) continue;
      const sim = titleSimilarity(prev.title, cur.title);
      const gapHours =
        (Date.parse(cur.publishedAt) - Date.parse(prev.publishedAt)) / 3_600_000;
      if (sim > 0.9 || (gapHours > 6 && sim > 0.8)) {
        syndicated.add(cur.id);
        break;
      }
    }
  }
  return syndicated;
}

/** C = 1 - n_conflicts / n_checked。必须在去重之后计算，否则没有意义。 */
export function consistencyScore(
  claims: Claim[],
  excluded: Set<string> = new Set(),
): { value: number; nChecked: number; nConflicts: number } {
  const usable = claims.filter((c) => c.sourceIds.some((id) => !excluded.has(id)));
  // 没有可比对的断言时给中性 0.5，而不是 1：什么都没检查不等于万事一致。
  if (usable.length === 0) return { value: 0.5, nChecked: 0, nConflicts: 0 };

  /**
   * 分组键必须带单位。只按 attr 分组时，"营收 $3.2B" 与 "营收 3.2 million"
   * 会被归一成同一个数字，然后判为"完全一致"——三个数量级的差距被当成共识。
   * 单位不同就归入不同组，组内不足两条即不参与比对。
   */
  const groups = new Map<string, Map<string, string>>();
  for (const c of usable) {
    const key = c.attr.toLowerCase() + "\u0000" + (c.unit ?? "").toLowerCase();
    const bySource = groups.get(key) ?? new Map<string, string>();
    // 同一来源说三遍不算三次核对：按 sourceId 收敛，后说的覆盖先说的。
    for (const id of c.sourceIds) {
      if (excluded.has(id)) continue;
      bySource.set(id, normalizeValue(c.value));
    }
    groups.set(key, bySource);
  }

  /**
   * 口径是"每一条独立来源的说法"，不是"每一条断言"。
   * 以前按断言计数，同一篇稿子拆出的三条相同 value 就能把 nChecked 顶到 3、
   * conflicts 为 0、consistency 拿满分，而实际上只有一个来源说过这件事。
   */
  let nChecked = 0;
  let nConflicts = 0;
  for (const bySource of groups.values()) {
    if (bySource.size < 2) continue;
    nChecked += bySource.size;
    const freq = new Map<string, number>();
    for (const v of bySource.values()) freq.set(v, (freq.get(v) ?? 0) + 1);
    let modeValue = "";
    let modeCount = -1;
    for (const [v, n] of freq) {
      if (n > modeCount) {
        modeCount = n;
        modeValue = v;
      }
    }
    for (const v of bySource.values()) if (v !== modeValue) nConflicts += 1;
  }

  if (nChecked === 0) return { value: 0.5, nChecked: 0, nConflicts: 0 };
  return { value: 1 - nConflicts / nChecked, nChecked, nConflicts };
}

export function bandOf(score: number): Confidence["band"] {
  if (score >= 0.75) return "high";
  if (score >= 0.5) return "medium";
  return "low";
}

export function computeConfidence(
  sources: RawSource[],
  claims: Claim[],
): Confidence {
  if (sources.length === 0) {
    return {
      independence: 0,
      firstHand: 0,
      consistency: 0,
      score: 0,
      band: "low",
      nOwners: 0,
      nSyndicated: 0,
      nChecked: 0,
      nConflicts: 0,
    };
  }

  const owners = new Set(sources.map(ownerOf));
  const syndicated = findSyndicatedIds(sources);
  const independence = independenceScore(owners.size);
  const firstHand = 1 - syndicated.size / sources.length;
  const consistency = consistencyScore(claims, syndicated);

  let score =
    WEIGHTS.firstHand * firstHand +
    WEIGHTS.independence * independence +
    WEIGHTS.consistency * consistency.value;

  // 软约束：独立 owner < 2 时不允许高置信（PRD 2.2）。
  if (owners.size < 2) score = Math.min(score, 0.45);

  /**
   * 一条断言都没能交叉核对时，不允许"高置信"。
   *
   * 一致性给的是中性 0.5，乘以 0.25 权重后，只要一手性和独立性接近满分，
   * 总分就会越过 0.75 —— 可这个 0.75 里没有任何一条事实被两个来源对上过，
   * 它只是在说"我数了 39 篇文章，它们来自 26 个域名"。
   * 独立性靠域名数量堆得动，一手性靠"没识别出转载"就能满分。
   * 只有一致性这一维真正代表"核验过"，它空转时，置信度不该接近高档：
   * 封到 0.64，稳落 medium，且界面上会把这条限制写成一行口径说明。
   */
  if (consistency.nChecked === 0) score = Math.min(score, 0.64);

  /**
   * 演示样本封顶。fixture 的"多家在报道"是我们自己写进样本里的，
   * 拿它去跑独立性只会得到漂亮且虚假的高分——这个产品最该防的错，
   * 就是让编造的事实显得可信。所以整批都是样本时，一律压到低档。
   */
  const demoOnly = sources.every((s) => s.provider === "fixture");
  if (demoOnly) score = Math.min(score, 0.34);

  // 先舍入再分档：否则 0.74996 显示成 0.75、档位却是 medium，界面自相矛盾。
  const rounded = Number(score.toFixed(4));

  return {
    independence,
    firstHand,
    consistency: consistency.value,
    score: rounded,
    band: bandOf(rounded),
    nOwners: owners.size,
    nSyndicated: syndicated.size,
    nChecked: consistency.nChecked,
    nConflicts: consistency.nConflicts,
  };
}

/** 低置信档不允许展示聚合数字（PRD 2.2 UI 行为表）。 */
export function allowsAggregateNumbers(confidence: Confidence): boolean {
  return confidence.band !== "low";
}

/** 整批结果都是本地演示样本时为真：调用方必须把这件事说出来，不能只靠徽章颜色。 */
export function isDemoOnly(sources: RawSource[]): boolean {
  return sources.length > 0 && sources.every((s) => s.provider === "fixture");
}
