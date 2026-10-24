/**
 * 最近查询：结果页的侧边栏要靠它做「跳回去」。
 *
 * 三个口径决定：
 *   1. **只存查询词**。存整份结果没有意义 —— 结果由服务端按当前数据重算，
 *      存下来的旧分数会在下一次打开时冒充「现在的结论」。
 *   2. **去重靠「提到最前」而不是「跳过」**：重复问同一句话是常态，
 *      列表里留两条一样的东西除了占位没有别的用处。
 *   3. **存储失败不抛**。隐私模式、配额满、被策略禁掉，都是正常情况，
 *      这时候界面应该照常工作，只是关掉标签页就记不住 —— 不提示、不报错。
 */

export const HISTORY_KEY = "probe:history:v1";

/** 只留 8 条：侧边栏是一列，不是历史档案馆。 */
export const HISTORY_MAX = 8;

/** 只要能读写字符串就行 —— 注入这个而不是直接摸 localStorage，才好在 Node 里测。 */
export type HistoryStore = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
};

function defaultStore(): HistoryStore | null {
  try {
    if (typeof localStorage === "undefined") return null;
    return localStorage;
  } catch {
    return null;
  }
}

/** 存坏了就当没有：宁可丢历史，也不要让一条脏数据把侧边栏整块炸掉。 */
export function parseHistory(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const out: string[] = [];
    for (const item of parsed) {
      if (typeof item !== "string") continue;
      const q = item.trim();
      if (!q || out.includes(q)) continue;
      out.push(q);
      if (out.length >= HISTORY_MAX) break;
    }
    return out;
  } catch {
    return [];
  }
}

/** 纯函数：把 q 提到最前、去重、截断。单测只测这一层，不碰存储。 */
export function mergeHistory(list: readonly string[], q: string): string[] {
  const query = q.trim();
  if (!query) return list.slice(0, HISTORY_MAX);
  const out = [query];
  for (const item of list) {
    if (item === query) continue;
    out.push(item);
    if (out.length >= HISTORY_MAX) break;
  }
  return out.slice(0, HISTORY_MAX);
}

export function readHistory(store: HistoryStore | null = defaultStore()): string[] {
  if (!store) return [];
  try {
    return parseHistory(store.getItem(HISTORY_KEY));
  } catch {
    return [];
  }
}

/** 写回并返回新列表：调用方拿返回值直接 setState，不必再读一遍。 */
export function pushHistory(
  q: string,
  store: HistoryStore | null = defaultStore(),
  base?: readonly string[],
): string[] {
  const current = base ?? readHistory(store);
  const next = mergeHistory(current, q);
  if (store) {
    try {
      store.setItem(HISTORY_KEY, JSON.stringify(next));
    } catch {
      // 存不住就算了：本次会话里列表照常可用。
    }
  }
  return next;
}

export function clearHistory(store: HistoryStore | null = defaultStore()): void {
  if (!store) return;
  try {
    store.setItem(HISTORY_KEY, "[]");
  } catch {
    // 同上
  }
}
