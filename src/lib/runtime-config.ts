
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

export function configFromRequest(request: Request): RuntimeConfig {
  const h = request.headers;
  const cfg: RuntimeConfig = {};
  const openai = cleanKey(h.get(CONFIG_HEADERS.openaiKey));
  const tavily = cleanKey(h.get(CONFIG_HEADERS.tavilyKey));
  const model = cleanModel(h.get(CONFIG_HEADERS.model));
  if (openai) cfg.openaiKey = openai;
  if (tavily) cfg.tavilyKey = tavily;
  if (model) cfg.model = model;
  return cfg;
}

export function withRuntimeConfig<T>(cfg: RuntimeConfig, fn: () => T): T {
  if (!cfg.openaiKey && !cfg.model && !cfg.tavilyKey) return fn();
  return store.run(cfg, fn);
}

export function currentConfig(): RuntimeConfig {
  return store.getStore() ?? {};
}

export function resolvedOpenaiKey(): string | undefined {
  return currentConfig().openaiKey || process.env.OPENAI_API_KEY || undefined;
}

export function resolvedModelId(): string {
  return currentConfig().model || process.env.PROBE_MODEL || "gpt-4.1-mini";
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