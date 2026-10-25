
import { AsyncLocalStorage } from "node:async_hooks";
import { CONFIG_HEADERS } from "@/lib/config-headers";

/**
 * 单次请求的运行时配置。
 *
 * 用户可以在设置面板里填自己的 OpenAI / Tavily key，key 只存在浏览器 localStorage，
 * 每次请求随 header 一起发到本服务 —— 所以它必须活在"这一次请求"里，不能进全局变量：
 * 同一台机器上两个标签页用两把不同的 key，全局变量会串号。
 *
 * 用 AsyncLocalStorage 而不是把 config 一路往下传：pipeline → agents → lib 的调用链很深，
 * 逐层加参数会把签名改得到处都是，而这个值本来就只有"当前请求"这一个作用域。
 */

export type RuntimeConfig = {
  openaiKey?: string;
  /** OpenAI 兼容服务的接口根地址（含 /v1）。空 = 官方 https://api.openai.com/v1。 */
  openaiBaseUrl?: string;
  model?: string;
  tavilyKey?: string;
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

export function withRuntimeConfig<T>(cfg: RuntimeConfig, fn: () => T): T {
  if (!cfg.openaiKey && !cfg.model && !cfg.tavilyKey && !cfg.openaiBaseUrl) return fn();
  return store.run(cfg, fn);
}

export function currentConfig(): RuntimeConfig {
  return store.getStore() ?? {};
}

export function resolvedOpenaiKey(): string | undefined {
  return currentConfig().openaiKey || process.env.OPENAI_API_KEY || undefined;
}

/** 接口根地址。三个来源：面板填的 → OPENAI_BASE_URL → 不填（SDK 自己走官方地址）。 */
export function resolvedOpenaiBaseUrl(): string | undefined {
  return currentConfig().openaiBaseUrl || cleanBaseUrl(process.env.OPENAI_BASE_URL) || undefined;
}

/** 明确指定用哪个模型：面板填的 → PROBE_MODEL → 官方默认。 */
export function resolvedModelId(): string {
  return currentConfig().model || process.env.PROBE_MODEL || DEFAULT_MODEL_ID;
}

/** 面板空着、env 也没配时用的模型；设置面板的 placeholder 也读它，免得两处对不上。 */
export const DEFAULT_MODEL_ID = "gpt-6-luna";

/** 用户是不是明确指定了模型（面板或 env 都算），界面据此显示「已指定」。 */
export function modelIsExplicit(): boolean {
  return Boolean(currentConfig().model || process.env.PROBE_MODEL);
}

export function resolvedTavilyKey(): string | undefined {
  return currentConfig().tavilyKey || process.env.TAVILY_API_KEY || undefined;
}

/** 设置面板要如实告诉用户"这一轮到底用了谁的 key"。 */
export function keySource(): "user" | "env" | "none" {
  const cfg = currentConfig();
  if (cfg.openaiKey) return "user";
  if (process.env.OPENAI_API_KEY) return "env";
  return "none";
}