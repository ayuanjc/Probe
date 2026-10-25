
import { createHash } from "node:crypto";
import { currentCallScope } from "./call-scope";
import { generateObject, generateText, streamText } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { z } from "zod";
import {
  keySource,
  resolvedModelId,
  resolvedOpenaiBaseUrl,
  resolvedOpenaiKey,
} from "@/lib/runtime-config";
import { readPositiveInt } from "@/lib/rate-limit";
import type { UsageSink } from "@/lib/metrics";

/**
 * LLM 适配层。所有模型调用都收敛在这一个文件里，理由有二：
 *   1. 没有 API key 时全链路仍然可跑（fixture 兜底），developer 不需要 credentials 才能看到界面；
 *   2. 换 provider / 换 SDK 版本时只改这里。
 *
 * key 现在有两个来源：请求头里用户自带的（设置面板填的，优先），以及服务端 env。
 * 所以 provider 必须显式 createOpenAI({ apiKey })，不能再用默认的 openai() —— 那个只会读 env。
 */

type Client = ReturnType<typeof createOpenAI>;
const clients = new Map<string, Client>();

function client(): Client | null {
  const key = resolvedOpenaiKey();
  if (!key) return null;
  // 缓存键必须带上接口地址：同一个 key 既能打官方，也能打 DeepSeek / 网关，
  // 只按 key 缓存会让「换了地址但地址没生效」这种问题看起来像上游抽风。
  const baseUrl = resolvedOpenaiBaseUrl();
  const cacheKey = key + "\u0000" + (baseUrl ?? "");
  const hit = clients.get(cacheKey);
  if (hit) return hit;
  // 同一组配置复用实例；表本身要有上限，否则切着玩会把旧 key 赖在内存里。
  if (clients.size > 8) clients.clear();
  const made = createOpenAI(baseUrl ? { apiKey: key, baseURL: baseUrl } : { apiKey: key });
  clients.set(cacheKey, made);
  return made;
}

/**
 * 一律走 chat completions，不走 OpenAI 新的 /responses。
 *
 * 理由：设置面板允许填任何「OpenAI 兼容」服务的接口地址，而那些服务
 * （DeepSeek / Kimi / 智谱 / 硅基流动 / 本地 Ollama …）实现的是
 * /chat/completions —— provider 默认会打 /v1/responses，于是「填了别家的地址
 * 却一直 404」。这里用的只有结构化 JSON 与流式文本，chat completions 全都覆盖。
 */
function chatModel(p: Client) {
  const id = resolvedModelId();
  return p.chat(id);
}

/**
 * 已经确认「不认 response_format=json_schema」的上游，按接口地址记下来。
 *
 * 一次 400 换一次记忆：同一个人接下来每一次结构化调用都省掉那一发必然失败的请求。
 * 地址空串代表官方，官方不需要走这条路，所以用 "official" 区分。
 */
const textOnlyUpstreams = new Set<string>();

/**
 * 记忆键 = 接口地址 + key 指纹。
 *
 * 只按地址记的话，任何人用自己的 key 指向一个拒过 json_schema 的网关，
 * 就会把**同一地址下的所有用户**（包括官方 key）一起拖进纯文本模式，
 * 直到进程重启 —— 换 key 也不失效。key 只进哈希，不进日志也不进内存可读位。
 */
function upstreamKey(): string {
  const base = resolvedOpenaiBaseUrl() ?? "official";
  const key = resolvedOpenaiKey() ?? "";
  const fp = key ? createHash("sha256").update(key).digest("hex").slice(0, 8) : "nokey";
  return base + "\u0000" + fp;
}

/**
 * 单次上游调用的墙钟上限。
 *
 * 之前完全没设：generateObject / generateText 既不传 abortSignal 也不带超时。
 * 上游「TCP 连上了但不回包」（网关挂起、TLS 黑洞、被墙到一半）时，
 * /api/search 与文档核验会无限期挂着 —— 客户端断开也不会停，而 takeBudget()
 * 早就把这一次记进额度了。默认 30s 是一次 chat 调用的合理上限，
 * 慢到超过它基本等于失败，早断早重试比一直等更划算。
 */
function callTimeoutMs(): number {
  return readPositiveInt("PROBE_LLM_TIMEOUT_MS", 30_000, { max: 300_000 });
}

/** 把「调用方 abort」与「自己超时」合成一个 signal。没有调用方 signal 时只带超时。 */
function callSignal(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(callTimeoutMs());
  return signal ? AbortSignal.any([timeout, signal]) : timeout;
}

/* ------------------------- 每日调用预算 ------------------------- */

/**
 * 服务端自带 key 时的每日模型调用上限。
 *
 * 之前这里完全没有额度概念：.env.example 里的 PROBE_DAILY_TOKEN_BUDGET 从来
 * 没被读过。把 API 挂到公网后，任何人循环打 /api/search 就能把服务端的 key
 * 烧到欠费 —— 限流只按 IP 算，换 IP 就绕过去了。所以加一层进程级日预算：
 * 达到上限后 llmEnabled() 返回 false，整条链路自动降级为本地模板，
 * 服务继续可用，只是不再花钱。
 *
 * 用户自带 key（设置面板填的）不计入预算：花的是他自己的钱，我们没有理由拦。
 */
const budgetState = { day: "", used: 0, warned: "" };

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function dailyCallBudget(): number {
  return readPositiveInt("PROBE_DAILY_LLM_CALLS", 2_000, { max: 1_000_000 });
}

/** 今日额度是否已用尽（仅对服务端 env key 生效）。 */
export function budgetExhausted(): boolean {
  if (keySource() !== "env") return false;
  if (budgetState.day !== today()) return false;
  return budgetState.used >= dailyCallBudget();
}

/** 今日已用调用数（运维观测用）。 */
export function budgetUsed(): number {
  return budgetState.day === today() ? budgetState.used : 0;
}

/* ---------------------- 每人每日调用预算（第二道闸） ---------------------- */

/**
 * 全局额度是一个人也能烧穿的。
 *
 * PROBE_DAILY_LLM_CALLS 是**进程级**计数器：一个登录用户连点十几次「生成面板」
 * 或者一轮核验（几十次上游）就能把它用光，然后所有人一起降级到本地模板，
 * 日志里只有一行「今日调用已达上限」，看不出是谁。所以再加一层按人计数：
 * 谁的额度用完，谁自己降级，别人不受影响。
 *
 * 只对服务端 env key 生效 —— 用户自带 key 花的是他自己的钱，没有理由拦。
 */
type ScopeBudget = { day: string; used: number; warned: boolean };

const scopeBudgets = new Map<string, ScopeBudget>();
const SCOPE_BUDGET_MAX_KEYS = 2_048;

export function perUserCallBudget(): number {
  return readPositiveInt("PROBE_DAILY_LLM_CALLS_PER_USER", 120, { max: 100_000 });
}

function scopeBudgetFor(key: string, day: string): ScopeBudget {
  const found = scopeBudgets.get(key);
  if (found && found.day === day) return found;
  if (scopeBudgets.size >= SCOPE_BUDGET_MAX_KEYS) {
    // 先清掉隔天的（正常情况下一天结束就都过期了）；还满就整体清空 ——
    // 这是一个额度计数器，清空的代价只是「有人今天多拿到一次额度」。
    for (const [k, v] of scopeBudgets) if (v.day !== day) scopeBudgets.delete(k);
    if (scopeBudgets.size >= SCOPE_BUDGET_MAX_KEYS) scopeBudgets.clear();
  }
  const fresh: ScopeBudget = { day, used: 0, warned: false };
  scopeBudgets.set(key, fresh);
  return fresh;
}

/** 当前请求所属用户的额度是否已用完（没有请求上下文时恒为 false）。 */
export function scopeBudgetExhausted(): boolean {
  if (keySource() !== "env") return false;
  const scope = currentCallScope();
  if (!scope) return false;
  const state = scopeBudgets.get(scope.key);
  if (!state || state.day !== today()) return false;
  return state.used >= perUserCallBudget();
}

/** 当前请求所属用户今天用掉的次数（运维观测用）。 */
export function scopeBudgetUsed(key: string): number {
  const state = scopeBudgets.get(key);
  return state && state.day === today() ? state.used : 0;
}

function takeBudget(): boolean {
  if (keySource() !== "env") return true;
  const day = today();
  if (budgetState.day !== day) {
    budgetState.day = day;
    budgetState.used = 0;
    budgetState.warned = "";
  }
  const cap = dailyCallBudget();
  if (budgetState.used >= cap) {
    if (budgetState.warned !== day) {
      budgetState.warned = day;
      console.warn(`[llm] 今日模型调用已达上限 ${cap} 次（PROBE_DAILY_LLM_CALLS），进入本地模板模式。`);
    }
    return false;
  }

  // 先判个人额度，再记全局：个人被拦时不该消耗别人的份。
  const scope = currentCallScope();
  if (scope) {
    const perCap = perUserCallBudget();
    const state = scopeBudgetFor(scope.key, day);
    if (state.used >= perCap) {
      if (!state.warned) {
        state.warned = true;
        console.warn(
          `[llm] ${scope.label} 今日调用已达上限 ${perCap} 次（PROBE_DAILY_LLM_CALLS_PER_USER），本次降级为本地模板。`,
        );
      }
      return false;
    }
    state.used += 1;
  }

  budgetState.used += 1;
  return true;
}

/**
 * 只给测试用：直接驱动一次额度判定。
 *
 * 生产路径里 takeBudget() 只在 generateStructured 内部调，外部碰不到；
 * 而额度这种东西恰恰是「串行调用三次，第三次该被拒」这种顺序性质，
 * 不注入真实上游就没法验。导出这一个入口，测试不必伪造 HTTP。
 */
export function __testTakeBudget(): boolean {
  return takeBudget();
}

/** 只给测试用：把一个 scope 的当日用量归零（用例之间互不污染）。 */
export function __testResetScopeBudget(key: string): void {
  scopeBudgets.delete(key);
}

/** 只给测试用：把进程级日用量归零，并允许重新读 PROBE_DAILY_LLM_CALLS。 */
export function __testResetGlobalBudget(): void {
  budgetState.day = "";
  budgetState.used = 0;
  budgetState.warned = "";
}

export function llmEnabled(): boolean {
  return Boolean(resolvedOpenaiKey()) && !budgetExhausted();
}

/** 当前这一轮实际会用的模型名（请求头 > env > 默认）。 */
export function modelId(): string {
  return resolvedModelId();
}

/**
 * 只有"再来一次可能就好了"的错误才重试。
 *
 * 401 / 403 / 400 / 模型名写错这几种，第二次请求必然同样失败 —— 白白多等一个往返，
 * 还会把限速配额翻倍消耗。之前是无差别重试两次。
 */
function isTransient(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  if (/\b(401|403|400|404)\b/.test(msg)) return false;
  if (/invalid[_ ]?api[_ ]?key|model[_ ]?not[_ ]?found|unsupported/.test(msg)) return false;
  // 状态码优先看字段：APICallError.message 装的是上游原话，常常不含 "429" 这种数字，
  // 只按文本判断会把限流当成「重试也白搭」，把 5xx 当成「重试没意义」。
  const status = statusOf(err);
  if (status === 400 || status === 401 || status === 403 || status === 404) return false;
  if (status === 408 || status === 409 || status === 425 || status === 429) return true;
  if (status !== undefined && status >= 500) return true;
  return /\b(408|409|425|429|5\d\d)\b|timeout|timed out|econnreset|econnrefused|fetch failed|network|socket hang up/.test(
    msg,
  );
}

/**
 * 取出上游 HTTP 状态码。
 *
 * 为什么不能只靠报错文本：AI SDK 的 `APICallError.message` 装的是**上游原话**
 * （比如 "response_format: 参数不被支持的类型"），状态码在字段里。
 * 所有判定都去正则里找数字，于是「收到了 400 但报错里没写 400」这种最常见的情况恰好漏掉。
 */
function statusOf(err: unknown): number | undefined {
  if (!err || typeof err !== "object") return undefined;
  const e = err as Record<string, unknown>;
  const raw = e.statusCode ?? e.status;
  return typeof raw === "number" && Number.isFinite(raw) ? raw : undefined;
}

export type StructuredCall<T> = {
  schema: z.ZodType<T>;
  system: string;
  prompt: string;
};

/**
 * 上游明确拒绝 response_format / json_schema 时的特征。
 *
 * generateObject 默认用 `response_format: {type:"json_schema"}`，这是官方新特性；
 * 一堆「OpenAI 兼容」的服务只认 `json_object`，甚至完全不认 response_format
 * （老版本 vLLM、部分自建网关、某些 Ollama 版本）。它们的报错长这样：
 *   Invalid parameter: response_format
 *   response_format json_schema is not supported
 * 这种情况重试同一个请求没有意义，得换一条路：普通文本输出 + 自己抠 JSON。
   *    *
   *    * DeepSeek 的实际措辞是 "This response_format type is unavailable now" —— 里面既没有
   *    * invalid 也没有 unsupported，于是这条判定漏掉过：结构化链路直接 return null，
   *    * 而 analyze 那边把空断言记成「未配置模型 key」，排查时会朝完全错误的方向找。
 */
export function rejectsJsonSchema(err: unknown): boolean {
  // 报错文本与上游响应体一起看：有的网关 message 只有一句中文，
  // 真正的字段名躺在 responseBody 里。
  const body =
    err && typeof err === "object" && typeof (err as Record<string, unknown>).responseBody === "string"
      ? ((err as Record<string, unknown>).responseBody as string)
      : "";
  const msg = ((err instanceof Error ? err.message : String(err)) + " " + body).toLowerCase();

  if (!/response_format|json_schema|json schema|structured output/.test(msg)) return false;
  if (
    /not support|unsupported|unavailable|invalid|unknown|unrecognized|not allowed|not available|does not support|isn't supported|不支持|不可用|暂不可用|不被支持|不接受|不被接受|不被认可|无法识别|不识别/.test(
      msg,
    )
  ) {
    return true;
  }
  /**
   * 有的兼容网关（含 DeepSeek 的若干版本）只回一句「response_format: 参数不被支持的类型」，
   * 既不写 invalid 也不写 unsupported，message 里甚至没有状态码 —— 状态码在 APICallError.statusCode。
   * 这种报文以前会被判成「不是格式问题」，于是重试一发注定相同的请求，
   * 然后整条结构化链路 return null：表现是面板全空，日志里只有一行平淡的 failed。
   * 400/422 说明请求本身被拒：只要报文里点了 response_format 这个名字，就算格式不支持。
   */
  const status = statusOf(err);
  if (status === 400 || status === 422) return true;
  return /\b(400|422)\b/.test(msg);
}

/** 从模型输出里抠出 JSON：容忍 ```json 围栏和前后废话，抠不出就返回 undefined。 */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = trimmed.match(/[`]{3}(?:json)?\s*([\s\S]*?)[`]{3}/i);
  const body = (fenced ? fenced[1] : trimmed).trim();
  const start = body.search(/[{[\]]/);
  if (start < 0) return undefined;
  const open = body[start];
  const close = open === "{" ? "}" : "]";
  const end = body.lastIndexOf(close);
  if (end <= start) return undefined;
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    return undefined;
  }
}

/* ------------------- 纯文本模式下的字段骨架 ------------------- */

/**
 * 把 zod schema 折成一份「JSON 骨架」，用于 text-only 上游的提示词。
 *
 * 为什么必须有：json_schema 模式由服务端把字段名塞给模型，而纯文本模式没有这层保障 ——
 * DeepSeek 这类上游拒掉 response_format 之后，模型会把 ClaimSchema 的 attr/value
 * 自己猜成 "claim"，于是 zod 复核必然失败、整条抽取静默返回 null。
 * 界面上看到的是「没有可核验断言」，日志里只有一行兜底失败 —— 极难定位。
 * 骨架把键名照抄给模型，是这个兜底能真正跑通的前提。
 */
function unwrapType(node: any): { inner: any; optional: boolean } {
  let cur = node;
  let optional = false;
  for (let i = 0; i < 8 && cur; i++) {
    const type = cur.type ?? cur._def?.type;
    if (type === "optional" || type === "nullable" || type === "default" || type === "prefault") {
      if (type === "optional") optional = true;
      cur = typeof cur.unwrap === "function" ? cur.unwrap() : cur._def?.innerType;
      continue;
    }
    break;
  }
  return { inner: cur, optional };
}

export function schemaSkeleton(schema: z.ZodType<unknown>): unknown {
  const node = schema as any;
  const type = node?.type ?? node?._def?.type;
  if (type === "object") {
    const rawShape = typeof node.shape === "function" ? node.shape() : (node.shape ?? node._def?.shape);
    const shape = typeof rawShape === "function" ? rawShape() : (rawShape ?? {});
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(shape)) {
      const { inner, optional } = unwrapType(shape[key]);
      const value = schemaSkeleton(inner as z.ZodType<unknown>);
      out[key] = optional ? (typeof value === "string" ? value + "（可省略）" : value) : value;
    }
    return out;
  }
  if (type === "array") {
    const element = node.element ?? node._def?.element ?? node._def?.type;
    const sample = element ? schemaSkeleton(element as z.ZodType<unknown>) : "任意";
    return [sample];
  }
  if (type === "enum") {
    const options = node.options ?? node._def?.values ?? node._def?.entries;
    const list = Array.isArray(options) ? options : options ? Object.values(options) : [];
    return list.length > 0 ? list.join("|") : "字符串";
  }
  if (type === "literal") return node.value ?? node._def?.value ?? "字面量";
  if (type === "union") {
    const options = node.options ?? node._def?.options ?? [];
    return options.length > 0 ? schemaSkeleton(options[0]) : "任意";
  }
  if (type === "number" || type === "int") return 0;
  if (type === "boolean") return true;
  if (type === "string") return "文本";
  return "任意";
}

/** 提示词里那段「照抄键名」的话。骨架本身由调用方的 schema 决定，不给模型自由发挥的余地。 */
export function skeletonHint(schema: z.ZodType<unknown>): string {
  return (
    "\n\n字段名与嵌套结构必须与下面这份骨架完全一致（照抄键名，值换成真实内容，" +
    "不要改名字、不要少字段、不要多加字段）：\n" +
    JSON.stringify(schemaSkeleton(schema), null, 1)
  );
}
/**
 * 兼容兜底：不用 response_format，让模型把 JSON 写在正文里，自己抠 + zod 校验。
 *
 * 只有在上游明确拒绝 json_schema 时才会走到这里。代价是格式更依赖模型自觉
 * （所以要 repair 提示 + zod 复核），收益是那些只实现 chat/completions 的服务能用了。
 */
async function structuredAsText<T>(
  p: Client,
  args: StructuredCall<T>,
  promptChars: number,
  sink?: UsageSink,
  signal?: AbortSignal,
): Promise<T | null> {
  const res = await generateText({
    model: chatModel(p),
    system:
      args.system +
      "\n\n输出要求：只输出一个 JSON 对象，不要 Markdown 代码块，不要任何解释文字，不要前后缀。" +
      // 纯文本模式没有 schema 帮你钉字段名，模型会自己编（实测把 attr/value 写成 claim）。
      skeletonHint(args.schema),
    prompt: args.prompt,
    temperature: 0,
    // 重试与外层显式循环重复：SDK 自带 maxRetries（默认 2）× 这里的 for 循环
    // = 单次逻辑调用最多 6 发上游，而额度只记 1 次。重试权收回到调用方。
    maxRetries: 0,
    abortSignal: callSignal(signal),
  });
  const parsed = extractJson(res.text);
  if (parsed === undefined) return null;
  const checked = args.schema.safeParse(parsed);
  if (!checked.success) return null;
  sink?.({
    kind: "structured",
    promptChars,
    outputChars: JSON.stringify(checked.data ?? null).length,
    ...tokensOf(res.usage),
  });
  return checked.data;
}

/**
 * 结构化调用：temperature 固定 0，失败不重试超过 1 次（PRD 2.2 抽取规格）。
 * 返回 null 表示不可用或失败 —— 调用方必须走降级路径，不允许抛到用户面前。
 */
export async function generateStructured<T>(
  args: StructuredCall<T>,
  sink?: UsageSink,
  signal?: AbortSignal,
): Promise<T | null> {
  const p = client();
  if (!p) return null;
  if (!takeBudget()) return null;
  const promptChars = args.system.length + args.prompt.length;

  // 这个上游以前拒过 json_schema：直接走文本模式，不再浪费一发必然 400 的请求。
  if (textOnlyUpstreams.has(upstreamKey())) {
    try {
      const loose = await structuredAsText(p, args, promptChars, sink, signal);
      if (loose !== null) return loose;
    } catch (err) {
      console.warn(
        "[llm] 已知不支持 json_schema 的上游，文本模式也失败：",
        err instanceof Error ? err.message.slice(0, 160) : err,
      );
    }
    return null;
  }

  /** 只在真正被拒一次之后才换路，别把「偶发 500」也当成格式问题。 */
  let triedTextMode = false;

  for (let attempt = 0; attempt < 2; attempt++) {
    // 第二次尝试是另一次真实调用：额度要再记一次，否则「一次逻辑调用」在报价上
    // 永远按一发算，重试风暴时预算计数低报 N 倍。额度用完就别再打第二次。
    if (attempt > 0 && !takeBudget()) return null;
    try {
      const res = await generateObject({
        model: chatModel(p),
        schema: args.schema,
        system: args.system,
        prompt: args.prompt,
        temperature: 0,
        // 同上：重试只由这个 for 负责，优先级与判定都在我们手上。
        maxRetries: 0,
        abortSignal: callSignal(signal),
      });
      sink?.({
        kind: "structured",
        promptChars,
        outputChars: JSON.stringify(res.object ?? null).length,
        ...tokensOf(res.usage),
      });
      return res.object;
    } catch (err) {
      if (!triedTextMode && rejectsJsonSchema(err)) {
        triedTextMode = true;
        if (textOnlyUpstreams.size > 64) textOnlyUpstreams.clear();
        textOnlyUpstreams.add(upstreamKey());
        console.warn(
          "[llm] 上游不支持 response_format=json_schema，改用纯文本 JSON 兜底：" +
            (err instanceof Error ? err.message.slice(0, 160) : ""),
        );
        try {
          const loose = await structuredAsText(p, args, promptChars, sink, signal);
          if (loose !== null) return loose;
        } catch (inner) {
          console.warn(
            "[llm] 纯文本 JSON 兜底也失败：",
            inner instanceof Error ? inner.message.slice(0, 160) : inner,
          );
        }
        break;
      }
      const retryable = isTransient(err);
      if (attempt === 1 || !retryable) {
        // 只记错误类型与状态码，绝不把 key 或完整响应体打到日志里。
        console.warn(
          "[llm] structured call failed" + (retryable ? "" : " (not retried)") + ":",
          err instanceof Error ? err.message : err,
        );
        break;
      }
    }
  }
  return null;
}

/** 摘要流式输出。无 key 时用可读的降级文本，保证 UI 永远有东西可流。 */
export async function* streamSummary(
  prompt: string,
  sink?: UsageSink,
  signal?: AbortSignal,
): AsyncGenerator<string> {
  const p = client();
  if (!p) {
    yield* fixtureSummary();
    return;
  }
  if (!takeBudget()) {
    yield* budgetNote();
    return;
  }
  let emitted = false;
  let failed = false;
  let outChars = 0;
  try {
    const result = streamText({
      model: chatModel(p),
      prompt,
      temperature: 0.2,
      /**
       * 带上 signal：调用方（SSE 生成器）发现客户端走了就 abort。
       * 不给的话，用户关掉页面后上游还会一直吐到结束 —— 线程和额度都白烧，
       * 而这一路上没有任何人再看那串字了。
       */
      ...(signal ? { abortSignal: signal } : {}),
    });
    // 用 fullStream 而不是 textStream：textStream 只吐文本，把 provider 的错误
    // （403 unsupported_country_region、401 key 无效…）吞成一条空流，
    // 于是「调用失败」和「模型回了个空字符串」在这里长得一模一样。
    for await (const part of result.fullStream) {
      if (part.type === "text-delta") {
        if (part.text.length > 0) emitted = true;
        outChars += part.text.length;
        yield part.text;
      } else if (part.type === "finish") {
        // usage 到这里才齐：提前上报只能报字符数，token 永远是 0。
        sink?.({
          kind: "summary",
          promptChars: prompt.length,
          outputChars: outChars,
          ...tokensOf(part.totalUsage),
        });
      } else if (part.type === "error") {
        failed = true;
        console.warn("[llm] stream error part:", part.error instanceof Error ? part.error.message : part.error);
      }
    }
  } catch (err) {
    // 主动 abort 不是故障：别在日志里把它写成"模型调用失败"。
    if (signal?.aborted) return;
    failed = true;
    console.warn("[llm] stream failed:", err instanceof Error ? err.message : err);
  }
  // 已经吐过字 = 真摘要写了一半断掉。这时候不能接一段「当前没有可用的模型 key」：
  // key 是有的（否则走不到这里），那句话是假的，而且会把半截真摘要说成模板产物。
  // 一个字都没吐，才补一句中性的失败说明，让读者知道后面为什么是空的。
  if (failed && !emitted) {
    yield* failureNote();
  } else if (failed && emitted) {
    /*
     * 断在半句上什么都不说，是最糟的一种：读者看到的是一句语法完整、语义不完整的话，
     * 会当成摘要的全部内容。补一句短的，明确「到这里就断了」。
     */
    yield* truncationNote();
  }
}

/** 流式中途断掉时的收尾说明（不猜原因，只说事实）。 */
function* truncationNote(): Generator<string> {
  const text = "（摘要到这里中断了：与模型的连接提前结束，后半段没有生成。）";
  for (let i = 0; i < text.length; i += 14) {
    yield text.slice(i, i + 14);
  }
}

/**
 * usage 的形状随 SDK 版本漂移（inputTokens / outputTokens / promptTokens …），
 * 所以只认「确实是数字」的字段：拿不到就是拿不到，不补 0 冒充测量值。
 */
function tokensOf(usage: unknown): { tokensIn?: number; tokensOut?: number } {
  if (!usage || typeof usage !== "object") return {};
  const u = usage as Record<string, unknown>;
  const pick = (...keys: string[]): number | undefined => {
    for (const k of keys) {
      const v = u[k];
      if (typeof v === "number" && Number.isFinite(v)) return v;
    }
    return undefined;
  };
  return {
    tokensIn: pick("inputTokens", "promptTokens"),
    tokensOut: pick("outputTokens", "completionTokens"),
  };
}

/** 有 key 但调用失败时的说明：只陈述观察到的事实，不猜配置。 */
function* failureNote(): Generator<string> {
  const text =
    "摘要没有生成：模型调用失败（key 无效、额度用尽或网络中断）。" +
    "下面的面板与信源由本地流水线算出，不依赖模型，照常可读。";
  for (let i = 0; i < text.length; i += 14) {
    yield text.slice(i, i + 14);
  }
}

/** 额度用完时的说明：说清为什么，而不是假装没有 key。 */
function* budgetNote(): Generator<string> {
  const text =
    "今日模型调用额度已用完，摘要改由本地模板生成。" +
    "下面的面板与信源由本地流水线算出，不依赖模型，照常可读；" +
    "在「设置」里填自己的 key 可以立刻恢复模型摘要（自带 key 不计入服务端额度）。";
  for (let i = 0; i < text.length; i += 14) {
    yield text.slice(i, i + 14);
  }
}

function* fixtureSummary(): Generator<string> {
  const text =
    "已按意图拆分并完成多源检索。当前没有可用的模型 key（设置面板未填写，服务端也没有 OPENAI_API_KEY），" +
    "因此摘要由本地模板生成，数字与图表均来自真实抓取或本地样本。" +
    "在「设置」里填自己的 key 后，此段将由模型流式生成。";
  // 片段太长会让前端每个事件都重渲染一次，太碎则事件数爆炸；14 字是折中值。
  for (let i = 0; i < text.length; i += 14) {
    yield text.slice(i, i + 14);
  }
}