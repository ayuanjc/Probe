import type { Region } from "./region";

/**
 * 后台「额度 / 设置」两页的数据组装。
 *
 * 为什么单独一个文件而不是写在路由里：这里全是纯计算（夹上下界、算剩余、按身份聚合），
 * 路由只负责鉴权与取数。把它抽出来就能直接测「用量超过上限时剩余是不是 0」这种边界，
 * 不用起 HTTP、不用伪造 Next 的 Request。
 *
 * 一条总原则：这里是**观测面板**，不是业务判定。任何字段缺失都应该显示成"—"或 0，
 * 绝不能因为一行数据奇怪而让整个面板 500 —— 运维看不到数字的时候最需要它。
 */

export type RetrievalRow = {
  name: string;
  /** 界面上的中文名。 */
  label: string;
  /** 当前区域是否允许调用这一源。 */
  allowed: boolean;
  /** 密钥/端点是否配好（wiki/hn/gdelt 不需要密钥，恒 true）。 */
  configured: boolean;
  /** 对应的环境变量名，方便运维照着改。 */
  env: string;
};

export type OpsQuotaUser = {
  id: string;
  username: string;
  used: number;
  remaining: number;
  /** 0–1，给进度条用；上限为 0 时按 1 算（已经不能再调了）。 */
  ratio: number;
};

export type OpsReport = {
  at: number;
  day: string;
  quota: {
    global: {
      cap: number;
      used: number;
      remaining: number;
      ratio: number;
      exhausted: boolean;
      from: "ui" | "env";
    };
    perUser: { cap: number; from: "ui" | "env" };
    keySource: "user" | "env" | "none";
    modelEnabled: boolean;
    users: OpsQuotaUser[];
    /** 没有绑定到任何账号的调用（定时任务、内部自检）。不并进任何人的账，单独报。 */
    unassigned: number;
  };
  model: { id: string; host: string; mode: "allowed" | "switched" | "blocked"; explicit: boolean };
  region: { value: Region; source: string; fallback: Region; retrieval: string[] };
  retrieval: RetrievalRow[];
  site: {
    url: string | null;
    icp: string | null;
    police: string | null;
    operator: string | null;
    contact: string | null;
  };
  guards: { authMode: string };
};

function clampRatio(used: number, cap: number): number {
  if (!Number.isFinite(used) || !Number.isFinite(cap)) return 0;
  if (cap <= 0) return 1;
  return Math.min(1, Math.max(0, used / cap));
}

function safeCount(n: unknown): number {
  const v = typeof n === "number" ? n : Number(n);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
}

export function buildOpsReport(input: {
  now: number;
  day: string;
  quota: {
    globalCap: number;
    globalUsed: number;
    perUserCap: number;
    globalFrom: "ui" | "env";
    perUserFrom: "ui" | "env";
    exhausted: boolean;
    keySource: "user" | "env" | "none";
    modelEnabled: boolean;
  };
  users: { id: string; username: string }[];
  /** scopeBudgetSnapshot() 的原样输出：key 形如 u:<id>。 */
  scopes: { key: string; used: number }[];
  model: { id: string; host: string; mode: "allowed" | "switched" | "blocked"; explicit: boolean };
  region: { value: Region; source: string; fallback: Region; retrieval: readonly string[] };
  retrieval: RetrievalRow[];
  site: OpsReport["site"];
  guards: { authMode: string };
}): OpsReport {
  const globalCap = safeCount(input.quota.globalCap);
  const globalUsed = safeCount(input.quota.globalUsed);
  const perUserCap = safeCount(input.quota.perUserCap);

  const byId = new Map<string, number>();
  let unassigned = 0;
  for (const row of input.scopes) {
    // key 的构造只有一处（search/verify/module 三处都用 "u:" + user.id），
    // 这里按前缀切开；不是这个形状的（老版本、脚本直调）一律记到 unassigned，
    // 不要硬塞给第一个用户 —— 那会让某个人平白多出一截用量。
    const used = safeCount(row.used);
    if (row.key.startsWith("u:")) {
      const id = row.key.slice(2);
      byId.set(id, (byId.get(id) ?? 0) + used);
    } else {
      unassigned += used;
    }
  }

  const users: OpsQuotaUser[] = input.users
    .map((u) => {
      const used = byId.get(u.id) ?? 0;
      return {
        id: u.id,
        username: u.username,
        used,
        remaining: Math.max(0, perUserCap - used),
        ratio: clampRatio(used, perUserCap),
      };
    })
    .sort((a, b) => b.used - a.used || a.username.localeCompare(b.username));

  return {
    at: input.now,
    day: input.day,
    quota: {
      global: {
        cap: globalCap,
        used: globalUsed,
        remaining: Math.max(0, globalCap - globalUsed),
        ratio: clampRatio(globalUsed, globalCap),
        exhausted: input.quota.exhausted,
        from: input.quota.globalFrom,
      },
      perUser: { cap: perUserCap, from: input.quota.perUserFrom },
      keySource: input.quota.keySource,
      modelEnabled: input.quota.modelEnabled,
      users,
      unassigned,
    },
    model: input.model,
    region: { ...input.region, retrieval: [...input.region.retrieval] },
    retrieval: input.retrieval,
    site: input.site,
    guards: input.guards,
  };
}
