
import { z } from "zod";

/**
 * 布局快照（PRD 2.5）。
 *
 * 两条硬规则写在这里，而不是留给调用方记得：
 * 1. 快照带 schemaVersion + layoutVersion，升级后版本对不上就整份丢弃，
 *    **不硬渲染** —— 用一个旧版本的坐标去摆一版新模块，得到的不是"恢复了布局"，
 *    而是随机错位，用户还得自己再拖一遍。
 * 2. 恢复时按模块 id 逐个对齐：库里多出来的、界面上已经没有的 id 一律丢掉，
 *    否则旧查询的卡片会以"幽灵位置"占住网格。
 *
 * 存储目前是 localStorage：Supabase 未配置（.env 里没有 key），
 * 写一个连不上的远端只会让"保存成功"变成假话。快照结构按 PRD 定义，
 * 接上 Supabase 时换掉 read/write 两个函数即可。
 */

export const LAYOUT_SCHEMA_VERSION = 1;

/** 网格几何：12 列 / 行高 28px / 间距 24px。改了这里必须升 layoutVersion。 */
export const LAYOUT_VERSION = "rgl12x28m24-v2";
export const GRID_COLS = 12;
export const GRID_ROW_HEIGHT = 28;
/** 间距 24px（gap-6）。旧版本是 12px，坐标无法平移复用，所以跟着 layoutVersion 一起升。 */
export const GRID_MARGIN = 24;

const KEY_PREFIX = "probe:layout";

export const GridItemSchema = z.object({
  i: z.string().min(1),
  x: z.number().int().min(0).max(GRID_COLS - 1),
  y: z.number().int().min(0).max(2000),
  w: z.number().int().min(1).max(GRID_COLS),
  h: z.number().int().min(1).max(60),
});
export type GridItem = z.infer<typeof GridItemSchema>;

export const LayoutSnapshotSchema = z.object({
  schemaVersion: z.number().int(),
  layoutVersion: z.string(),
  query: z.string(),
  savedAt: z.string(),
  items: z.array(GridItemSchema).max(32),
});
export type LayoutSnapshot = z.infer<typeof LayoutSnapshotSchema>;

export type SizeHint = { id: string; w: number; h: number };

/** 同一句话的不同写法（大小写、多余空格）应该命中同一份快照。 */
export function layoutKey(query: string): string {
  const normalized = query.trim().replace(/\s+/g, " ").toLowerCase();
  return KEY_PREFIX + ":" + LAYOUT_VERSION + ":" + normalized;
}

function store(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    // Safari 隐私模式下 localStorage 存在但写入抛错，getItem 也可能抛。
    window.localStorage.getItem(KEY_PREFIX);
    return window.localStorage;
  } catch {
    return null;
  }
}

/** 按阅读顺序贪心排布：放不下就换行，位置只由模块尺寸决定，可复现。 */
export function autoLayout(hints: SizeHint[]): GridItem[] {
  const out: GridItem[] = [];
  let x = 0;
  let y = 0;
  let rowH = 0;

  for (const hint of hints) {
    const w = Math.max(2, Math.min(GRID_COLS, Math.round(hint.w)));
    const h = Math.max(2, Math.round(hint.h));
    if (x + w > GRID_COLS) {
      x = 0;
      y += rowH;
      rowH = 0;
    }
    out.push({ i: hint.id, x, y, w, h });
    x += w;
    rowH = Math.max(rowH, h);
  }
  return out;
}

function clampItem(item: GridItem): GridItem {
  const w = Math.max(2, Math.min(GRID_COLS, item.w));
  const x = Math.max(0, Math.min(GRID_COLS - w, item.x));
  return { i: item.i, x, y: Math.max(0, item.y), w, h: Math.max(2, item.h) };
}

/**
 * 用快照里的坐标覆盖默认排布。快照里没有的新模块排到当前最底部，
 * 而不是塞回 (0,0) —— 那会正好压住用户摆在左上角的卡片。
 */
export function reconcile(stored: GridItem[], defaults: GridItem[]): {
  items: GridItem[];
  restored: number;
  missing: number;
} {
  const byId = new Map(stored.map((s) => [s.i, s]));
  let bottom = 0;
  for (const s of stored) bottom = Math.max(bottom, s.y + s.h);

  let restored = 0;
  const items = defaults.map((d) => {
    const hit = byId.get(d.i);
    if (hit) {
      restored += 1;
      return clampItem({ ...hit, i: d.i });
    }
    const placed = clampItem({ ...d, i: d.i, x: 0, y: bottom });
    bottom += placed.h;
    return placed;
  });

  const alive = new Set(defaults.map((d) => d.i));
  const missing = stored.filter((s) => !alive.has(s.i)).length;
  return { items, restored, missing };
}

export type LoadResult = {
  items: GridItem[];
  /** 给用户看的一句话。没有可说的就是 null，不要用"布局加载成功"占位。 */
  notice: string | null;
};

export function loadLayout(query: string, defaults: GridItem[]): LoadResult {
  if (defaults.length === 0) return { items: [], notice: null };

  const ls = store();
  if (!ls) return { items: defaults, notice: null };

  let raw: string | null = null;
  try {
    raw = ls.getItem(layoutKey(query));
  } catch {
    return { items: defaults, notice: null };
  }
  if (!raw) return { items: defaults, notice: null };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { items: defaults, notice: "上次保存的布局无法解析，已回到默认排布。" };
  }

  /**
   * 先确认解出来的是个对象：本机里可能存着 "null"、"[]"、"3" 这类合法 JSON 但结构不对的值
   * （旧版本写的、别的脚本写的、手改的）。不判这一下，下面读 .layoutVersion 直接 TypeError，
   * 而它在 effect 里跑 —— 整个网格会白掉，且不只是一个键丢了的问题。
   */
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { items: defaults, notice: "本机存的布局数据格式不对，已回到默认排布。" };
  }

  // 版本先判，再判结构：格式对但版本不同，说明是旧坐标，直接丢。
  const version = (parsed as { layoutVersion?: unknown }).layoutVersion;
  const schemaVersion = (parsed as { schemaVersion?: unknown }).schemaVersion;
  if (version !== LAYOUT_VERSION || schemaVersion !== LAYOUT_SCHEMA_VERSION) {
    return {
      items: defaults,
      notice: "上次布局来自不同版本（" + String(version) + " → " + LAYOUT_VERSION + "），已丢弃。",
    };
  }

  const result = LayoutSnapshotSchema.safeParse(parsed);
  if (!result.success) {
    return { items: defaults, notice: "上次保存的布局结构不完整，已回到默认排布。" };
  }

  const { items, restored, missing } = reconcile(result.data.items, defaults);
  // 一个 id 都对不上（模块全换了）时不能返回"整体下移后的排布"：顶部会空一大片。
  if (restored === 0) return { items: defaults, notice: null };

  const notes = ["已恢复上次布局（" + restored + " 项）"];
  if (missing > 0) notes.push("丢弃 " + missing + " 个已不存在的模块位置");
  return { items, notice: notes.join(" · ") };
}

export function saveLayout(query: string, items: GridItem[], aliveIds: string[]): boolean {
  const ls = store();
  if (!ls) return false;

  const alive = new Set(aliveIds);
  /**
   * 落盘前先夹到 schema 的合法区间，而不是"夹不进去就报存不下"。
   * 拖到大尺寸（h > 60）或模块多过 32 张时，schema 会拒绝整份快照，
   * 界面就一直显示"本机存储写入失败"——那是把自己的边界当成用户的问题。
   */
  const seen = new Set<string>();
  const clean = items
    .filter((it) => alive.has(it.i) && !seen.has(it.i) && Boolean(seen.add(it.i)))
    .map((it) => ({
      i: it.i,
      x: Math.min(Math.max(0, Math.round(it.x)), GRID_COLS - 1),
      y: Math.min(Math.max(0, Math.round(it.y)), 2000),
      w: Math.min(Math.max(1, Math.round(it.w)), GRID_COLS),
      h: Math.min(Math.max(1, Math.round(it.h)), 60),
    }))
    .slice(0, 32);

  const snapshot: LayoutSnapshot = {
    schemaVersion: LAYOUT_SCHEMA_VERSION,
    layoutVersion: LAYOUT_VERSION,
    query: query.trim(),
    savedAt: new Date().toISOString(),
    items: clean,
  };

  const parsed = LayoutSnapshotSchema.safeParse(snapshot);
  if (!parsed.success) return false;

  try {
    ls.setItem(layoutKey(query), JSON.stringify(parsed.data));
    return true;
  } catch {
    // 配额满 / 隐私模式：返回 false，界面上说"没存下"，而不是假装存了。
    return false;
  }
}

export function clearLayout(query: string): void {
  const ls = store();
  if (!ls) return;
  try {
    ls.removeItem(layoutKey(query));
  } catch {
    // 忽略：清不掉时下次保存会覆盖。
  }
}
