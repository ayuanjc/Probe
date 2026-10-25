/**
 * 从 URL 里读发布日期。
 *
 * 为什么需要：Tavily 的 basic depth 不回 published_date，博查的 field 也不稳；
 * 而「最近三个月」这条约束对没有日期的条目等于没生效。很多新闻站的 URL 里
 * 本来就带着可证明的日期（/2026/10/24/、.../2026102421845...），读它不算猜 ——
 * 但**必须标明是推导的**，因为它和页面自己声明的发布时间不是同一等证据。
 *
 * 只认能唯一确定的形状，认不出就回 null（不猜）。宁可少一个日期，
 * 也不要让一个错日期把结果挤出时间窗。
 */

const DAY_MS = 86_400_000;

function valid(y: number, m: number, d: number, nowMs: number): boolean {
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return false;
  const nowYear = new Date(nowMs).getUTCFullYear();
  if (y < 1990 || y > nowYear + 1) return false;
  if (m < 1 || m > 12) return false;
  if (d < 1 || d > 31) return false;
  // 用 Date 自己校验（2 月 30 日会被规范化成 3 月 2 日，所以要比对月份）
  const probe = new Date(Date.UTC(y, m - 1, d));
  return probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d;
}

function iso(y: number, m: number, d: number): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return y + "-" + p(m) + "-" + p(d);
}

/**
 * 返回值是「日」精度（YYYY-MM-DD）而不是时间戳：URL 只能给出哪一天，
 * 给出更细的精度就是编造。时间窗比对时按「这一天整天」参与（见 time-window.ts）。
 */
export function dateFromUrl(rawUrl: string, nowMs: number = Date.now()): string | null {
  if (!rawUrl) return null;
  let path = rawUrl;
  try {
    const u = new URL(rawUrl);
    path = u.pathname + (u.search || "");
  } catch {
    // 不是合法 URL 也照样试一下：上游偶尔回相对路径
  }

  // 1) 分隔符形状：/2026/10/24/ 与 2026-10-24、2026_10_24
  const sep = /(?:^|[^0-9])(\d{4})[/_-](\d{1,2})[/_-](\d{1,2})(?:[^0-9]|$)/.exec(path);
  if (sep) {
    const y = Number(sep[1]);
    const m = Number(sep[2]);
    const d = Number(sep[3]);
    if (valid(y, m, d, nowMs)) return iso(y, m, d);
  }

  // 2) 连续数字：/202610242184529872.html 与 /20261024/
  //    只看前 8 位是 yyyymmdd，后面允许跟时分秒/序号（不必解读）。
  // 长度上限放宽到 20：cngold 那种 /202610242184529872.html 是 18 位（日期 + 毫秒级序号）。
  const run = /(?:^|[^0-9])(\d{8,20})(?:[^0-9]|$)/.exec(path);
  if (run) {
    const digits = run[1];
    const y = Number(digits.slice(0, 4));
    const m = Number(digits.slice(4, 6));
    const d = Number(digits.slice(6, 8));
    if (valid(y, m, d, nowMs)) return iso(y, m, d);
  }

  return null;
}

/** 这条日期是「从 URL 推导的」而不是页面声明的 —— 界面要能说出这个区别。 */
export function dateFromUrlDayEnd(day: string): number | null {
  const t = Date.parse(day + "T00:00:00.000Z");
  return Number.isNaN(t) ? null : t + DAY_MS - 1;
}