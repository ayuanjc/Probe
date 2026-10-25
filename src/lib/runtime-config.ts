
import { AsyncLocalStorage } from "node:async_hooks";
import { CONFIG_HEADERS } from "@/lib/config-headers";
import { DEFAULT_MODEL_ID } from "@/lib/model-presets";
import { countryLabel } from "@/lib/country-names";
import {
  defaultRegion,
  isPrivateIp,
  normalizeIp,
  parseRegionWord,
  resolveRegionForRequest,
  type Region,
  type RegionSource,
} from "@/lib/region";
import { clientKey } from "@/lib/request-guard";
import { decideModel, regionPolicy, type ModelDecision } from "@/lib/region-policy";

/**
 * 单次请求的运行时配置。
 *
 * 用户可以在设置面板里填自己的 OpenAI / Tavily key，key 只存在浏览器 localStorage，
 * 每次请求随 header 一起发到本服务 —— 所以它必须活在"这一次请求"里，不能进全局变量：
 * 同一台机器上两个标签页用两把不同的 key，全局变量会串号。
 *
 * 用 AsyncLocalStorage 而不是把 config 一路往下传：pipeline → agents → lib 的调用链很深，
 * 逐层加参数会把签名改得到处都是，而这个值本来就只有"当前请求"这一个作用域。
 *
 * 区域（region）也挂在这里：它同样"只对这一次请求成立"，而且比 key 更靠上游 ——
 * 它决定这次请求**允许**用什么端点，再往下才轮到"用谁的 key"。
 */

export type RuntimeConfig = {
  openaiKey?: string;
  /** OpenAI 兼容服务的接口根地址（含 /v1）。空 = 官方 https://api.openai.com/v1。 */
  openaiBaseUrl?: string;
  model?: string;
  tavilyKey?: string;
  /** 这次请求按哪套出境规则处理。缺省时按 mode / 兜底区域现算，见 resolvedRegion()。 */
  region?: Region;
  regionSource?: RegionSource;
  /** 边缘节点给出的国家码，仅用于日志与说明文案。 */
  regionCountry?: string;
  /**
   * 这次请求的来访地址（按 PROBE_TRUSTED_PROXY_HOPS 取，与限流同一套）。
   * 只回显给请求者本人；不落库、不进日志、不参与区域判定的缓存。
   */
  visitorIp?: string;
  ipScope?: IpScope;
  /** 与区域有关的、要给用户看到的一句话（去重后进 run.degraded）。 */
  notes?: string[];
};

export { CONFIG_HEADERS } from "@/lib/config-headers";

const store = new AsyncLocalStorage<RuntimeConfig>();

/** 脏值一律当没有：空白串、超长串、带换行的串都不该被当成 key 去请求上游。 */
function cleanKey(v: string | null): string | undefined {
  if (!v) return undefined;
  const t = v.trim();
  if (t.length < 8 || t.length > 400) return undefined;
  if (/\s/.test(t)) return undefined;
  return t;
}

/**
 * 模型名不是标识符。原来只收 [A-Za-z0-9._:-]，于是「openai/gpt-4o」
 * （网关的写法）、「gpt 4o」（照抄文档里带空格的写法）都**静默变成「没填」**，
 * 用户看到的是模型没换，却没有任何提示。现在放行 / 和 @，只挡控制字符与冒号外的空白。
 */
function cleanModel(v: string | null): string | undefined {
  if (!v) return undefined;
  const t = v.trim();
  if (t.length < 2 || t.length > 80) return undefined;
  if (!/^[A-Za-z0-9._:/@-]+$/.test(t)) return undefined;
  return t;
}

/**
 * 接口地址只接受 http(s) 绝对 URL，且只留 scheme + host + path：
 * 去掉尾斜杠、去掉 query / fragment / userinfo —— 这三样在 baseURL 里没有任何意义，
 * 却能让「看起来填对了」的地址在 SDK 拼 path 时变成 https://host/v1/../authors/bearer 这种笑话。
 *
 * 元数据地址单独挡掉：这台机器在云上，任何用户的 key 都足以把服务端变成一个
 * 「带凭证访问 169.254.169.254」的跳板。填了别人的网关不拦，填元数据地址一律当没填。
 */
const BLOCKED_HOSTS = new Set(["169.254.169.254", "metadata.google.internal", "metadata"]);

export function cleanBaseUrl(v: string | null | undefined): string | undefined {
  if (!v) return undefined;
  const t = v.trim();
  if (t.length < 12 || t.length > 300) return undefined;
  if (/\s/.test(t)) return undefined;
  let url: URL;
  try {
    url = new URL(t);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
  if (!url.hostname) return undefined;
  if (BLOCKED_HOSTS.has(url.hostname.toLowerCase())) return undefined;
  const path = url.pathname.replace(/\/+$/, "");
  return url.origin + path;
}

export function configFromRequest(request: Request): RuntimeConfig {
  const h = request.headers;
  const cfg: RuntimeConfig = {};
  const openai = cleanKey(h.get(CONFIG_HEADERS.openaiKey));
  const tavily = cleanKey(h.get(CONFIG_HEADERS.tavilyKey));
  const model = cleanModel(h.get(CONFIG_HEADERS.model));
  const baseUrl = cleanBaseUrl(h.get(CONFIG_HEADERS.openaiBaseUrl));
  if (openai) cfg.openaiKey = openai;
  if (tavily) cfg.tavilyKey = tavily;
  if (model) cfg.model = model;
  if (baseUrl) cfg.openaiBaseUrl = baseUrl;
  return cfg;
}

/**
 * 路由入口用这个，而不是 configFromRequest()。
 *
 * 它比同步版多做的唯一一件事是判定区域 —— 而判定可能要查一次 IP 库，
 * 所以必须是 async。同步版保留下来给测试和不关心区域的调用方用。
 */
export async function prepareRuntimeConfig(request: Request): Promise<RuntimeConfig> {
  const cfg = configFromRequest(request);
  const hit = await resolveRegionForRequest(request);
  cfg.region = hit.region;
  cfg.regionSource = hit.source;
  if (hit.country) cfg.regionCountry = hit.country;

  // 来访地址字段只是"回显给本人"用的，不参与判定、不进缓存。
  // direct = 取不到（直连部署或没经过代理），如实说"取不到"而不是编一个。
  const ip = clientKey(request);
  if (ip && ip !== "direct") {
    cfg.visitorIp = normalizeIp(ip);
    cfg.ipScope = isPrivateIp(ip) ? "private" : "public";
  } else {
    cfg.ipScope = "unknown";
  }
  return cfg;
}

export function withRuntimeConfig<T>(cfg: RuntimeConfig, fn: () => T): T {
  if (!cfg.openaiKey && !cfg.model && !cfg.tavilyKey && !cfg.openaiBaseUrl && !cfg.region) return fn();
  return store.run(cfg, fn);
}

export function currentConfig(): RuntimeConfig {
  return store.getStore() ?? {};
}

/* ------------------------------ 区域 ------------------------------ */

/**
 * 这次请求所属区域。没有请求上下文时（定时任务、单元测试）按 env 现算：
 * PROBE_REGION_MODE → PROBE_DEFAULT_REGION → "cn"。
 */
export function resolvedRegion(): Region {
  const cfg = currentConfig();
  if (cfg.region) return cfg.region;
  return parseRegionWord(process.env.PROBE_REGION_MODE) ?? defaultRegion();
}

/** 区域结论的来源，界面用它解释"为什么这一轮少了几个源"。 */
export function regionOrigin(): RegionSource | "unknown" {
  const cfg = currentConfig();
  if (cfg.regionSource) return cfg.regionSource;
  if (parseRegionWord(process.env.PROBE_REGION_MODE)) return "mode";
  return "unknown";
}

/** 给 run.degraded / 界面提示记一条区域说明。同一条只记一次。 */
export function noteRegion(text: string): void {
  const cfg = store.getStore();
  if (!cfg) return;
  const notes = (cfg.notes ??= []);
  if (!notes.includes(text)) notes.push(text);
}

/** pipeline 收尾时把区域说明并进 degraded。 */
export function regionNotes(): string[] {
  return [...(currentConfig().notes ?? [])];
}

const decisions = new WeakMap<RuntimeConfig, ModelDecision>();

/**
 * 这次请求的模型端点结论（allowed / switched / blocked）。
 *
 * 按 config 对象记忆化：一次请求里 pipeline 会调好几次（intent、摘要、断言、核验），
 * 每次都重算一遍白名单没有意义，而 config 对象在同一个 ALS 上下文里是同一份。
 */
export function modelDecision(): ModelDecision {
  const cfg = currentConfig();
  const cached = decisions.get(cfg);
  if (cached) return cached;

  const decision = decideModel(cfg.region ?? resolvedRegion(), {
    baseUrl: cfg.openaiBaseUrl || cleanBaseUrl(process.env.OPENAI_BASE_URL),
    modelId: cfg.model || process.env.PROBE_MODEL || DEFAULT_MODEL_ID,
  });

  if (decision.kind === "switched") {
    noteRegion(`region:model_switched:${decision.from}->${decision.host}`);
  } else if (decision.kind === "blocked") {
    // 只有"本来有模型可用、被区域规则拦下"才值得提示。本身就没配 key 的机器不该看到这句。
    noteRegion(`region:model_blocked:${decision.host}`);
  }

  decisions.set(cfg, decision);
  return decision;
}

export function resolvedOpenaiKey(): string | undefined {
  const decision = modelDecision();
  if (decision.kind === "blocked") return undefined;
  if (decision.kind === "switched") return decision.apiKey;
  return currentConfig().openaiKey || process.env.OPENAI_API_KEY || undefined;
}

/** 接口根地址。三个来源：面板填的 → OPENAI_BASE_URL → 不填（SDK 自己走官方地址）。 */
export function resolvedOpenaiBaseUrl(): string | undefined {
  const decision = modelDecision();
  if (decision.kind === "blocked") return undefined;
  if (decision.kind === "switched") return decision.baseUrl;
  return currentConfig().openaiBaseUrl || cleanBaseUrl(process.env.OPENAI_BASE_URL) || undefined;
}

/** 明确指定用哪个模型：境内的兜底端点自带模型 → 面板填的 → PROBE_MODEL → 官方默认。 */
export function resolvedModelId(): string {
  const decision = modelDecision();
  if (decision.kind === "switched") return decision.modelId;
  return currentConfig().model || process.env.PROBE_MODEL || DEFAULT_MODEL_ID;
}

/**
 * 面板空着、env 也没配时用的模型。真值在 src/lib/model-presets.ts（同一份数据还喂设置面板的
 * placeholder 与下拉候选），这里只是转出去，留给调用方的 import 路径不变。
 */
export { DEFAULT_MODEL_ID };

/** 用户是不是明确指定了模型（面板或 env 都算），界面据此显示「已指定」。 */
export function modelIsExplicit(): boolean {
  return Boolean(currentConfig().model || process.env.PROBE_MODEL);
}

/**
 * 境外检索的 key。境内区域直接返回 undefined —— 这是出境闸门的第二道用处：
 * 集外检索（agents/heldout.ts）与 retrieve 走的是同一个函数，闸门放这里，
 * 就不可能出现"检索层挡住了、核验层又偷偷发一次"。
 */
export function resolvedTavilyKey(): string | undefined {
  if (!regionPolicy(resolvedRegion()).retrieval.includes("tavily")) return undefined;
  return currentConfig().tavilyKey || process.env.TAVILY_API_KEY || undefined;
}

/** 境内检索（博查）的 key。只从 env 取：用户不该为了用探针自己去买一个国内搜索额度。 */
export function resolvedBochaKey(): string | undefined {
  return cleanKey(process.env.BOCHA_API_KEY ?? "") ?? undefined;
}

/** 设置面板要如实告诉用户"这一轮到底用了谁的 key"。 */
export function keySource(): "user" | "env" | "none" {
  const cfg = currentConfig();
  if (cfg.openaiKey) return "user";
  if (modelDecision().kind === "switched") return "env";
  if (process.env.OPENAI_API_KEY) return "env";
  return "none";
}

/**
 * 诊断用：当前区域的模型与检索去向（/api/region 与设置面板都读它）。
 *
 * 特意把「被拦」与「切换」分开汇报：面板上写「境内」而模型其实被拦下来不敢调，
 * 与「境内 + 已切到境内端点」是两件事，用户看到的下一步完全不同。
 */
export type IpScope = "public" | "private" | "unknown";

export function regionSummary(): {
  region: Region;
  source: string;
  country?: string;
  countryName?: string;
  /** 来访地址：只有 ipScope === "public" 才有值，回显给本人看。 */
  ip?: string;
  ipScope: IpScope;
  modelHost: string;
  modelMode: "allowed" | "switched" | "blocked";
  retrieval: readonly string[];
} {
  const decision = modelDecision();
  const cfg = currentConfig();
  return {
    region: resolvedRegion(),
    source: regionOrigin(),
    ...(cfg.regionCountry ? { country: cfg.regionCountry } : {}),
    ...(cfg.regionCountry ? { countryName: countryLabel(cfg.regionCountry) } : {}),
    ...(cfg.ipScope === "public" && cfg.visitorIp ? { ip: cfg.visitorIp } : {}),
    ipScope: cfg.ipScope ?? "unknown",
    modelHost: decision.host,
    modelMode: decision.kind,
    retrieval: regionPolicy(resolvedRegion()).retrieval,
  };
}
