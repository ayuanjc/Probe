/**
 * 时间窗过滤。独立成纯函数有两个原因：一是这里错过一次，代价很大；二是它必须能单测。
 *
 * 2026-10-25 的事故：Tavily 的 basic depth 不返回 published_date，取数代码就写
 * `published_date ?? new Date().toISOString()` —— 把「不知道发布日期」当成了「就是今天」。
 * 而意图的窗口上界恰好是「解析意图那一刻」，检索发出去、回来已经过了十几秒，
 * 于是这一批虽然是刚取到的，却全被判成「比窗口末端还晚」：15 条进、15 条全军覆没，
 * 用户看到的是 6 条 fixture 假数据，而不是任何真实结果。
 *
 * 结论：**缺失的日期只能用「未知」表示**。未知不等于今天，未知也不等于越界。
 * 未知条目保留，但必须单独计数（stats.window:undated）并在界面上说出来 ——
 * 因为「按最近三个月」查回来的稿子如果没日期，它到底算不算在窗口内，我们并不知道。
 */

export type Windowed = { publishedAt: string; provider?: string };

export type WindowPartition<T extends Windowed> = {
  kept: T[];
  dropped: T[];
  undated: T[];
  droppedByProvider: Record<string, number>;
};

/** 解析不了返回 null（不是 0，也不是 now —— 那两种都会被当成真实时间参与计算）。 */
export function parseInstant(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

export function windowBoundsMs(
  from: string,
  to: string,
  now: number = Date.now(),
): { fromMs: number; toMs: number } {
  const f = parseInstant(from);
  const t = parseInstant(to);
  return {
    fromMs: f === null ? 0 : f,
    toMs: t === null ? now + 86_400_000 : t,
  };
}

export function partitionByWindow<T extends Windowed>(
  items: T[],
  fromMs: number,
  toMs: number,
): WindowPartition<T> {
  const kept: T[] = [];
  const dropped: T[] = [];
  const undated: T[] = [];
  const droppedByProvider: Record<string, number> = {};

  for (const item of items) {
    const t = parseInstant(item.publishedAt);
    if (t === null) {
      kept.push(item);
      undated.push(item);
      continue;
    }
    if (t >= fromMs && t <= toMs) {
      kept.push(item);
      continue;
    }
    dropped.push(item);
    const p = item.provider ?? "unknown";
    droppedByProvider[p] = (droppedByProvider[p] ?? 0) + 1;
  }

  return { kept, dropped, undated, droppedByProvider };
}