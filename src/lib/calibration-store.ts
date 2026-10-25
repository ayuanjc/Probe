import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  calibrationReport,
  calibrationVerdict,
  ECE_BUDGET,
  type CalibrationPair,
  type CalibrationResult,
  type CalibrationVerdict,
} from "./calibration";

/**
 * 校准样本库（P3）：把「我们当时说多少」与「后来人工判对错」记在一起。
 *
 * 为什么必须先记账再谈校准：`calibrationReport()` 只有在拿到 (预测, 对错) 对子时
 * 才算得出 ECE；没有标签，它永远返回 null → 界面永远 unknown。
 * 之前 P3 只落了度量层，缺的就是这一半。
 *
 * 三条口径（改动前先读）：
 * 1. **预测只能服务端写**。接口不接受客户端传来的 predicted —— 谁都能自己填分，
 *    ECE 立刻退化成自我打分。样本由 /api/evidence 在核验成功时落一条。
 * 2. **一条样本一个标签**。重复标是覆盖而不是追加：
 *    append-only 的标签会让人反复改到「校准看起来不错」为止。
 * 3. **有上限**。超过 MAX_SAMPLES 丢最老的 —— 校准看的是近期的偏差，
 *    不是三年的考古。文件也不会因此无限长大。
 */

export type CalibrationSample = {
  id: string;
  /** 落样本的时间（ms）。 */
  at: number;
  /** 这一轮给出的吻合度，就是「预测」。 */
  predicted: number;
  /** 进入分母的断言数（已判定）。 */
  judged: number;
  /** 有效独立源数：事后复盘时用来分桶（低 nEff 的样本不该和高的混在一起看）。 */
  nEff: number;
  /** 被反驳的条数。 */
  contradicted: number;
  /** 这一轮一共核了几条（含不可核的）。 */
  claims: number;
  /** 人工判定：true = 这一轮的结论成立；null = 还没人看。 */
  correct: boolean | null;
  labeledAt: number | null;
};

export const MAX_SAMPLES = 5_000;

/** 追加一条（按 id 去重），超出上限丢最老的。纯函数，方便单测。 */
export function appendSample(
  list: readonly CalibrationSample[],
  sample: CalibrationSample,
  max: number = MAX_SAMPLES,
): CalibrationSample[] {
  const kept = list.filter((s) => s.id !== sample.id);
  kept.push(sample);
  return kept.length > max ? kept.slice(kept.length - max) : kept;
}

/** 给一条样本贴标签。返回 ok=false 表示这条不存在（多半是样本上限把它挤掉了）。 */
export function applyLabel(
  list: readonly CalibrationSample[],
  id: string,
  correct: boolean,
  at: number,
): { list: CalibrationSample[]; ok: boolean } {
  let ok = false;
  const next = list.map((s) => {
    if (s.id !== id) return s;
    ok = true;
    return { ...s, correct, labeledAt: at };
  });
  return { list: ok ? next : list.slice(), ok };
}

/**
 * 只把「已标注 + 预测是有限数」的样本变成 (predicted, correct) 对子。
 * 未标注的样本不是「猜它错」，它是没有观测 —— 混进去会让 ECE 凭空变小。
 */
export function pairsOf(list: readonly CalibrationSample[]): CalibrationPair[] {
  const out: CalibrationPair[] = [];
  for (const s of list) {
    if (s.correct === null) continue;
    if (!Number.isFinite(s.predicted)) continue;
    out.push({ predicted: s.predicted, correct: s.correct });
  }
  return out;
}

export type SampleCounts = {
  total: number;
  labeled: number;
  unlabeled: number;
  /** 最近一条样本的时间；空库为 null。 */
  latestAt: number | null;
};

export function countSamples(list: readonly CalibrationSample[]): SampleCounts {
  let labeled = 0;
  let latestAt: number | null = null;
  for (const s of list) {
    if (s.correct !== null) labeled += 1;
    if (latestAt === null || s.at > latestAt) latestAt = s.at;
  }
  return { total: list.length, labeled, unlabeled: list.length - labeled, latestAt };
}

export type CalibrationSnapshot = {
  counts: SampleCounts;
  /** 有标注才算得出来；没有就 null（不是 0 —— 0 会被读成「完美校准」）。 */
  report: CalibrationResult | null;
  verdict: CalibrationVerdict;
  budget: number;
  /** 最近 10 条，给界面看「有没有人在标」。 */
  recent: CalibrationSample[];
};

export function snapshotOf(list: readonly CalibrationSample[], binCount = 10): CalibrationSnapshot {
  const pairs = pairsOf(list);
  const report = calibrationReport(pairs, binCount);
  return {
    counts: countSamples(list),
    report,
    verdict: calibrationVerdict(report),
    budget: ECE_BUDGET,
    recent: list.slice(-10).reverse(),
  };
}

/* ------------------------------ 落盘 ------------------------------ */

type SampleStore = { read(): Promise<string | null>; write(text: string): Promise<void> };

function dataFile(): string {
  const dir = process.env.PROBE_DATA_DIR?.trim() || path.join(process.cwd(), ".data");
  return path.join(dir, "calibration", "samples.json");
}

/** 默认存储：与授权库同一套（.data + 原子 rename + 0o600）。 */
export function defaultStore(): SampleStore {
  const file = dataFile();
  return {
    async read() {
      try {
        return await fs.readFile(file, "utf8");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw err;
      }
    },
    async write(text: string) {
      await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      const tmp = file + ".tmp-" + process.pid + "-" + Date.now();
      await fs.writeFile(tmp, text, { encoding: "utf8", mode: 0o600 });
      await fs.rename(tmp, file);
      await fs.chmod(file, 0o600).catch(() => undefined);
    },
  };
}

/**
 * 解析：坏文件当空库 **不抛**。
 * 与授权库相反的选择，理由是后果不同 —— 授权库读不出来时种一个管理员是灾难，
 * 而校准库读不出来最多是「这一轮开始重新攒样本」，下一个请求就能覆盖掉坏文件。
 */
export function parseSamples(raw: string | null): CalibrationSample[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const list = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object" && Array.isArray((parsed as { samples?: unknown }).samples)
      ? (parsed as { samples: unknown[] }).samples
      : [];
  const out: CalibrationSample[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const s = item as Partial<CalibrationSample>;
    if (typeof s.id !== "string" || s.id.length === 0) continue;
    if (typeof s.predicted !== "number" || !Number.isFinite(s.predicted)) continue;
    const predicted = Math.min(1, Math.max(0, s.predicted));
    out.push({
      id: s.id,
      at: typeof s.at === "number" && Number.isFinite(s.at) ? s.at : 0,
      predicted,
      judged: typeof s.judged === "number" && Number.isFinite(s.judged) ? s.judged : 0,
      nEff: typeof s.nEff === "number" && Number.isFinite(s.nEff) ? s.nEff : 0,
      contradicted:
        typeof s.contradicted === "number" && Number.isFinite(s.contradicted) ? s.contradicted : 0,
      claims: typeof s.claims === "number" && Number.isFinite(s.claims) ? s.claims : 0,
      correct: typeof s.correct === "boolean" ? s.correct : null,
      labeledAt:
        typeof s.labeledAt === "number" && Number.isFinite(s.labeledAt) ? s.labeledAt : null,
    });
  }
  return out.slice(-MAX_SAMPLES);
}

/* 读-改-写要串行：两个请求同时落样本，后写的会把先写的覆盖掉。 */
let queue: Promise<unknown> = Promise.resolve();

function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

export async function readSamples(store: SampleStore = defaultStore()): Promise<CalibrationSample[]> {
  return parseSamples(await store.read());
}

export type RecordInput = {
  predicted: number;
  judged: number;
  nEff: number;
  contradicted: number;
  claims: number;
};

/** 落一条样本，返回它的 id（界面拿它去贴标签）。 */
export async function recordSample(
  input: RecordInput,
  store: SampleStore = defaultStore(),
): Promise<CalibrationSample> {
  const sample: CalibrationSample = {
    id: "cal_" + randomUUID(),
    at: Date.now(),
    predicted: Math.min(1, Math.max(0, input.predicted)),
    judged: Math.max(0, Math.round(input.judged)),
    nEff: Math.max(0, input.nEff),
    contradicted: Math.max(0, Math.round(input.contradicted)),
    claims: Math.max(0, Math.round(input.claims)),
    correct: null,
    labeledAt: null,
  };
  await serialize(async () => {
    const list = parseSamples(await store.read());
    await store.write(JSON.stringify(appendSample(list, sample), null, 2));
  });
  return sample;
}

export async function labelSample(
  id: string,
  correct: boolean,
  store: SampleStore = defaultStore(),
): Promise<{ ok: boolean; sample: CalibrationSample | null }> {
  return serialize(async () => {
    const list = parseSamples(await store.read());
    const res = applyLabel(list, id, correct, Date.now());
    if (!res.ok) return { ok: false, sample: null };
    await store.write(JSON.stringify(res.list, null, 2));
    const hit = res.list.find((s) => s.id === id) ?? null;
    return { ok: true, sample: hit };
  });
}

export async function calibrationSnapshot(
  store: SampleStore = defaultStore(),
): Promise<CalibrationSnapshot> {
  return snapshotOf(await readSamples(store));
}
