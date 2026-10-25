/**
 * 服务端错误账本（进程内存，环）。
 *
 * 为什么需要它：现在 5xx 只会回一句公共文案（上游异常里带内部地址、模型名、响应体片段，
 * 不能回给浏览器），而真正的原因只落在 journald 里 —— 运维修完 nginx 想看「最近半小时
 * 到底哪一类错误在冒」，得先 ssh 上去 grep。这里留一份最近 200 条，后台「设置」页直接看。
 *
 * 三条纪律：
 *   1. 只记**公共文案**（截 300 字），不记原始异常对象 —— 否则密钥、内网地址会顺着面板漏出去；
 *   2. 永不抛错。记账失败不该让本该返回 500 的请求变成未捕获异常；
 *   3. 只记 5xx。4xx 是客户端问题，混进来会把真正需要修的东西淹掉。
 */
export type ErrorEntry = {
  at: number;
  /** 谁身上发生的：登录用户标签、或 "无主"（定时任务、流在请求返回后才跑）。 */
  scope: string;
  status: number;
  code: string;
  message: string;
};

const MAX_ENTRIES = 200;
const MAX_MESSAGE = 300;

const ring: ErrorEntry[] = [];
let total = 0;

export function recordError(input: {
  status: number;
  code: string;
  message: string;
  scope?: string | null;
}): void {
  const status = Number.isFinite(input.status) ? Math.floor(input.status) : 500;
  // 只留服务端错误：4xx 是调用方的问题，记进来会把信号淹掉。
  if (status < 500) return;
  const message = (input.message ?? "").slice(0, MAX_MESSAGE);
  const scope = (input.scope ?? "").trim() || "无主";
  const code = (input.code ?? "").trim() || "internal";
  ring.push({ at: Date.now(), scope, status, code, message });
  total += 1;
  // 环满就丢最老的：内存里只有最近 MAX_ENTRIES 条，进程重启归零。
  while (ring.length > MAX_ENTRIES) ring.shift();
}

/** 最近的错误，最新的在前。 */
export function recentErrors(limit = 40): ErrorEntry[] {
  const n = Number.isFinite(limit) ? Math.max(0, Math.min(Math.floor(limit), MAX_ENTRIES)) : 40;
  return ring.slice(-n).reverse().map((e) => ({ ...e }));
}

/** 按 code 聚合的计数（降序），给面板一句话看出「哪一类在冒」。 */
export function errorCounters(): { code: string; count: number }[] {
  const by = new Map<string, number>();
  for (const e of ring) by.set(e.code, (by.get(e.code) ?? 0) + 1);
  return [...by.entries()]
    .map(([code, count]) => ({ code, count }))
    .sort((a, b) => b.count - a.count || a.code.localeCompare(b.code));
}

/** 进程启动以来记过的总条数（环被丢掉的也算）。 */
export function errorTotal(): number {
  return total;
}

/** 只给测试用：清空环与计数。 */
export function __testResetErrors(): void {
  ring.length = 0;
  total = 0;
}
