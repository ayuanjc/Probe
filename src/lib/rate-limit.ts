/**
 * 限流与并发闸门 —— 服务端唯一的限流实现。
 *
 * 设计要点：
 * 1. 环境变量解析**永不猜**：非数字 / 负数 / 0 一律回落到安全默认值，
 *    并且打一条 warn。历史上 `Number(process.env.X ?? 12)` 在 X="abc"
 *    时会得到 NaN，所有比较都是 false，于是限流静默失效（等于完全不限）。
 * 2. 键表有上限（maxKeys）：每个键的命中时间戳数组长度也被 limit 夹住，
 *    因此内存占用有确定上界，伪造来源刷不爆进程。
 * 3. 两级限流：per-key（按客户端）+ global（整个进程）。global 让「换 IP
 *    继续刷」也受限，per-key 让正常用户之间互不影响。
 */

export type LimitDecision = {
  ok: boolean;
  /** 被拒时建议的 Retry-After 秒数（向上取整，至少 1）。 */
  retryAfterSeconds: number;
  /** 当前窗口内已用次数。 */
  used: number;
};

export type Limiter = {
  readonly name: string;
  readonly limit: number;
  readonly windowMs: number;
  check(key: string): LimitDecision;
  reset(): void;
  size(): number;
};

function warnBadEnv(name: string, raw: string, fallback: number): void {
  console.warn(
    `[rate-limit] ${name}=${JSON.stringify(raw)} 不是有效的正数，按默认值 ${fallback} 处理。`,
  );
}

/**
 * 读取整数环境变量。空字符串 / 未设置 -> fallback；
 * 非法值 -> fallback（并 warn）；合法值向下取整，并夹在 [min, max] 内。
 *
 * min 默认 1（限流阈值必须为正，否则等于关掉限流）。
 * 少数「0 是有意义的取值」的旋钮（如 PROBE_TRUSTED_PROXY_HOPS=0 表示
 * 前面没有反向代理）必须显式传 min: 0，否则会被当成笔误回落默认值。
 */
export function readPositiveInt(
  name: string,
  fallback: number,
  opts: { max?: number; min?: number } = {},
): number {
  const min = opts.min ?? 1;
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min) {
    warnBadEnv(name, raw, fallback);
    return fallback;
  }
  const capped = opts.max !== undefined ? Math.min(n, opts.max) : n;
  return Math.max(min, Math.floor(capped));
}

/** 读取 0..1 的环境变量（用于开关类配置）。 */
export function readFlag(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const v = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(v)) return true;
  if (["0", "false", "no", "off"].includes(v)) return false;
  console.warn(`[rate-limit] ${name}=${JSON.stringify(raw)} 不是布尔值，按默认值 ${fallback} 处理。`);
  return fallback;
}

/** 固定窗口（滑动近似）限流器：窗口内命中次数达到 limit 即拒绝。 */
export function createLimiter(opts: {
  name: string;
  limit: number;
  windowMs?: number;
  /** 键表上限，超出时先清理过期键，再淘汰最早插入的键。 */
  maxKeys?: number;
}): Limiter {
  const name = opts.name;
  const limit = Math.max(1, Math.floor(opts.limit));
  const windowMs = Math.max(1_000, Math.floor(opts.windowMs ?? 60_000));
  const maxKeys = Math.max(16, Math.floor(opts.maxKeys ?? 2_048));

  const hits = new Map<string, number[]>();

  function prune(now: number): void {
    for (const [key, list] of hits) {
      const alive = list.filter((t) => now - t < windowMs);
      if (alive.length === 0) hits.delete(key);
      else hits.set(key, alive);
    }
  }

  function check(key: string): LimitDecision {
    const k = key.slice(0, 200);
    const now = Date.now();
    let list = hits.get(k);
    if (!list) {
      if (hits.size >= maxKeys) {
        prune(now);
        // 清理后仍然过满：淘汰最早插入的键，保证内存有界。
        while (hits.size >= maxKeys) {
          const oldest = hits.keys().next();
          if (oldest.done) break;
          hits.delete(oldest.value);
        }
      }
      list = [];
      hits.set(k, list);
    }
    // 丢掉窗口外的历史（数组长度本就 <= limit，这里只是清陈旧项）
    while (list.length > 0 && now - list[0] >= windowMs) list.shift();

    if (list.length >= limit) {
      const oldest = list[0] ?? now;
      const retryMs = windowMs - (now - oldest);
      return {
        ok: false,
        used: list.length,
        retryAfterSeconds: Math.max(1, Math.ceil(retryMs / 1000)),
      };
    }
    list.push(now);
    return { ok: true, used: list.length, retryAfterSeconds: 0 };
  }

  return {
    name,
    limit,
    windowMs,
    check,
    reset: () => hits.clear(),
    size: () => hits.size,
  };
}

export type Gate = {
  readonly max: number;
  readonly active: number;
  /** 占用一个槽位；返回 null 表示已满。 */
  acquire(): (() => void) | null;
};

/**
 * 并发闸门：限制同一时刻真正在跑的
 * 昂贵操作（模型调用 / 外部抓取）数量，防止「少量 IP 就能把额度烧干」
 * 以及异步任务堆积把进程压垮。
 */
export function createGate(max: number): Gate {
  const cap = Math.max(1, Math.floor(max));
  let active = 0;
  return {
    get max() {
      return cap;
    },
    get active() {
      return active;
    },
    acquire() {
      if (active >= cap) return null;
      active += 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        active = Math.max(0, active - 1);
      };
    },
  };
}
