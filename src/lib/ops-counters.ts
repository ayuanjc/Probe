/**
 * 运行时计数（进程内存）：今天有几次提问、几轮核验、降级最多的原因是什么。
 *
 * 为什么不做正经埋点（把请求打到外部分析平台）：
 *   - 这个站在境内、给境内用户用，把行为数据发给第三方分析平台是又一条数据出境；
 *   - 它要的答案只有三个：今天有多少次操作、哪一类降级最多、有没有人被额度拦。
 *     这三件事在自己进程里数一数就够了，发出去的每一份都是净负债。
 *
 * 代价说清楚：进程内存 = 重启归零，多进程不共享（现在是单进程 systemd，符合现状）。
 * 跨天自动清零，所以面板上永远只有「今天」。要历史就看 journald 与 probe.db。
 */

export type OpName = "search" | "verify" | "module" | "import" | "export";

export type CountersSnapshot = {
  /** 统计所属的那一天（YYYY-MM-DD，进程本地时区）。 */
  day: string;
  /** 按次数降序。 */
  ops: { name: string; count: number }[];
  /** 降级原因，按次数降序，最多 40 条。 */
  degraded: { reason: string; count: number }[];
  /** 降级条目总数（一条结果可以同时有多条降级原因）。 */
  degradedTotal: number;
};

const MAX_REASONS = 60;
const MAX_OPS = 20;

function dayKey(now = Date.now()): string {
  const d = new Date(now);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return y + "-" + m + "-" + day;
}

/**
 * 把机器码折成一类：
 *   claims:quote_miss_3        → claims:quote_miss
 *   region:model_switched:a->b → region:model_switched
 *   wiki:failed                → wiki:failed
 * 不折的话「第 3 条引文缺失」和「第 4 条」会成为两个键，面板上永远是一条条孤零零的 1。
 */
export function normalizeReason(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const text = raw.trim();
  if (!text) return null;
  const parts = text.split(":");
  const head = parts[0].replace(/_\d+$/, "").slice(0, 40);
  if (!head) return null;
  const second = parts[1];
  // 第二段是「数字或箭头」时丢掉：那些是实例编号/变化记录，不是类别。
  if (!second || /^\d+$/.test(second) || second.includes("->")) return head;
  return head + ":" + second.replace(/_\d+$/, "").slice(0, 40);
}

type Bucket = { day: string; ops: Map<string, number>; reasons: Map<string, number>; degradedTotal: number };

function emptyBucket(day: string): Bucket {
  return { day, ops: new Map(), reasons: new Map(), degradedTotal: 0 };
}

let bucket: Bucket = emptyBucket(dayKey());

/** 跨天翻页：每次写之前调一次，别指望定时器（没有请求就没有必要翻页）。 */
function roll(): Bucket {
  const today = dayKey();
  if (bucket.day !== today) bucket = emptyBucket(today);
  return bucket;
}

export function recordOp(op: OpName | string): void {
  const name = typeof op === "string" ? op.trim().slice(0, 20) : "";
  if (!name) return;
  const b = roll();
  // 上限只防「有人拿机器码当 op 名」把 Map 撑大；正常只有上面五个值。
  if (!b.ops.has(name) && b.ops.size >= MAX_OPS) return;
  b.ops.set(name, (b.ops.get(name) ?? 0) + 1);
}

export function recordDegraded(reasons: readonly unknown[] | null | undefined): void {
  if (!reasons || reasons.length === 0) return;
  const b = roll();
  for (const raw of reasons) {
    const key = normalizeReason(raw);
    if (!key) continue;
    b.degradedTotal += 1;
    if (!b.reasons.has(key) && b.reasons.size >= MAX_REASONS) {
      // 超出上限的并进 other：宁可丢类别名，也不要丢「今天降级了多少次」这个总数。
      b.reasons.set("other", (b.reasons.get("other") ?? 0) + 1);
      continue;
    }
    b.reasons.set(key, (b.reasons.get(key) ?? 0) + 1);
  }
}

function sorted(map: Map<string, number>, limit: number): { name: string; count: number }[] {
  return [...map.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, limit);
}

export function countersSnapshot(): CountersSnapshot {
  const b = roll();
  return {
    day: b.day,
    ops: sorted(b.ops, MAX_OPS),
    degraded: sorted(b.reasons, 40).map((r) => ({ reason: r.name, count: r.count })),
    degradedTotal: b.degradedTotal,
  };
}

export function __testResetCounters(): void {
  bucket = emptyBucket(dayKey());
}
