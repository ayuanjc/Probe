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
  const order = [...sources].sort(
    (a, b) => Date.parse(a.publishedAt) - Date.parse(b.publishedAt),
  );
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
  if (usable.length === 0) return { value: 1, nChecked: 0, nConflicts: 0 };

  const groups = new Map<string, string[]>();
  for (const c of usable) {
    const key = c.attr.toLowerCase();
    const arr = groups.get(key) ?? [];
    arr.push(normalizeValue(c.value));
    groups.set(key, arr);
  }

  let nChecked = 0;
  let nConflicts = 0;
  for (const values of groups.values()) {
    if (values.length < 2) continue;
    nChecked += values.length;
    const freq = new Map<string, number>();
    for (const v of values) freq.set(v, (freq.get(v) ?? 0) + 1);
    let modeValue = "";
    let modeCount = -1;
    for (const [v, n] of freq) {
      if (n > modeCount) {
        modeCount = n;
        modeValue = v;
      }
    }
    nConflicts += values.filter((v) => v !== modeValue).length;
  }

  if (nChecked === 0) return { value: 1, nChecked: 0, nConflicts: 0 };
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

  return {
    independence,
    firstHand,
    consistency: consistency.value,
    score: Number(score.toFixed(4)),
    band: bandOf(score),
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
