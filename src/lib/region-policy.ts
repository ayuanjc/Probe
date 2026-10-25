/**
 * 出境闸门：谁能被调用，取决于请求来自哪个区域。
 *
 * 这里不出网、不判断地域（那是 region.ts 的事），只回答一个问题：
 * 给定区域和想用的目标，这一步是放行、换成本地替代，还是拦下。
 *
 * 一条原则：拦下时宁可整条链降级，也不"顺手换个 key 再试"。
 * 拿用户的 OpenAI key 去撞 DeepSeek，只会换来一个语焉不详的 401，
 * 还会让日志里出现"境内请求但用的是境外服务商地址"这种说不清的东西。
 */

import type { Region } from "./region";

export type RetrievalProvider = "bocha" | "tavily" | "gdelt" | "wiki" | "hn";

export const ALL_RETRIEVAL_PROVIDERS: readonly RetrievalProvider[] = ["bocha", "gdelt", "hn", "wiki", "tavily"];

/**
 * 境内可调用的模型接口域名。
 *
 * 入选标准两条：服务商在境内运营、模型在国家网信办的生成式 AI 备案清单里。
 * 这张表**就是**出境闸门 —— 加一行等于放行一家服务商的数据出境，
 * 别凭"好像也是国内的"往里加。
 */
const CN_MODEL_HOSTS: readonly string[] = [
  "api.deepseek.com", // 深度求索
  "api.moonshot.cn", // 月之暗面 Kimi
  "open.bigmodel.cn", // 智谱 GLM
  "dashscope.aliyuncs.com", // 阿里百炼
  "api.siliconflow.cn", // 硅基流动
  "ark.cn-beijing.volces.com", // 火山方舟
  "qianfan.baidubce.com", // 百度千帆
  "api.minimax.chat", // MiniMax
  "api.baichuan-ai.com", // 百川
  "api.stepfun.com", // 阶跃星辰
  "api.lingyiwanwu.com", // 零一万物
  "api.hunyuan.cloud.tencent.com", // 腾讯混元
  "spark-api-open.xf-yun.com", // 讯飞星火
];

const PRIVATE_HOST_RE =
  /^(localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|::1|\[::1\])$/;

export type RegionPolicy = {
  region: Region;
  /** 模型接口是否允许任意域名（境外区域）还是只允许白名单（境内）。 */
  allowAnyModelHost: boolean;
  allowedModelHosts: readonly string[];
  /** 自建/内网模型端点：不论区域都放行（数据本来就没出网）。 */
  allowPrivateModelHost: boolean;
  retrieval: readonly RetrievalProvider[];
};

function envList(raw: string | undefined): string[] {
  return String(raw ?? "")
    .split(/[,;\s]+/)
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean);
}

/** 境内额外信任的模型域名（自建代理、企业专有网关），逗号分隔。 */
function cnExtraHosts(): string[] {
  return envList(process.env.PROBE_CN_EXTRA_MODEL_HOSTS).filter((v) => /^[a-z0-9.-]+$/.test(v));
}

/** 境内允许的检索源，默认只有博查（境内服务商）。 */
function cnRetrieval(region: Region): RetrievalProvider[] {
  if (region === "intl") return [...ALL_RETRIEVAL_PROVIDERS];
  const override = envList(process.env.PROBE_REGION_CN_RETRIEVAL).filter((v): v is RetrievalProvider =>
    (ALL_RETRIEVAL_PROVIDERS as readonly string[]).includes(v),
  );
  return override.length > 0 ? override : ["bocha"];
}

export function regionPolicy(region: Region): RegionPolicy {
  if (region === "intl") {
    return {
      region,
      allowAnyModelHost: true,
      allowedModelHosts: [],
      allowPrivateModelHost: true,
      retrieval: cnRetrieval("intl"),
    };
  }
  return {
    region,
    allowAnyModelHost: false,
    allowedModelHosts: [...CN_MODEL_HOSTS, ...cnExtraHosts()],
    allowPrivateModelHost: true,
    retrieval: cnRetrieval("cn"),
  };
}

export function isPrivateHost(host: string): boolean {
  return PRIVATE_HOST_RE.test(host.trim().toLowerCase());
}

/**
 * baseUrl → 域名。空串表示"官方默认"，按 api.openai.com 算：
 * 没写 baseUrl 恰恰是最危险的情况（默认打到 OpenAI 官方）。
 */
export function modelHostOf(baseUrl: string | undefined): string {
  const raw = (baseUrl ?? "").trim();
  if (!raw) return "api.openai.com";
  try {
    return new URL(raw.includes("://") ? raw : `https://${raw}`).hostname.toLowerCase();
  } catch {
    return raw.toLowerCase();
  }
}

export function hostAllowed(host: string, policy: RegionPolicy): boolean {
  if (policy.allowAnyModelHost) return true;
  const v = host.trim().toLowerCase();
  if (policy.allowPrivateModelHost && isPrivateHost(v)) return true;
  return policy.allowedModelHosts.some((h) => v === h || v.endsWith(`.${h}`));
}

export function retrievalAllowed(region: Region, provider: string): boolean {
  return (regionPolicy(region).retrieval as readonly string[]).includes(provider);
}

export type ModelDecision =
  | { kind: "allowed"; host: string }
  | { kind: "switched"; host: string; baseUrl: string; modelId: string; apiKey: string; from: string }
  | { kind: "blocked"; host: string };

function normalizeBaseUrl(raw: string): string | undefined {
  const v = raw.trim();
  if (!v) return undefined;
  try {
    const u = new URL(v.includes("://") ? v : `https://${v}`);
    if (u.protocol !== "http:" && u.protocol !== "https:") return undefined;
    return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, "")}`;
  } catch {
    return undefined;
  }
}

/**
 * 区域 → 这次到底用哪个模型端点。
 *
 * switched 只在运维显式配了 PROBE_CN_MODEL_KEY + PROBE_CN_MODEL_BASE_URL 时才成立。
 * 没配就直接 blocked：调用方拿不到 key，链路会诚实地降级成"没有模型可用"，
 * 而不是偷偷用境外 key 发一次请求。
 */
export function decideModel(
  region: Region,
  req: { baseUrl?: string; modelId: string },
): ModelDecision {
  const host = modelHostOf(req.baseUrl);
  const policy = regionPolicy(region);
  if (hostAllowed(host, policy)) return { kind: "allowed", host };

  const key = (process.env.PROBE_CN_MODEL_KEY ?? "").trim();
  const baseRaw = (process.env.PROBE_CN_MODEL_BASE_URL ?? "").trim();
  const baseUrl = normalizeBaseUrl(baseRaw);
  if (!key || !baseUrl) return { kind: "blocked", host };

  const fallbackHost = modelHostOf(baseUrl);
  // 兜底端点自己也得在名单里，否则等于把闸门装在自己身上。
  if (!hostAllowed(fallbackHost, policy)) return { kind: "blocked", host };

  return {
    kind: "switched",
    host: fallbackHost,
    baseUrl,
    modelId: (process.env.PROBE_CN_MODEL_ID ?? "").trim() || "deepseek-flash",
    apiKey: key,
    from: host,
  };
}
