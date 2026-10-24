
import { generateObject, streamText } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import type { z } from "zod";
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
  budgetState.used += 1;
  return true;
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
  return /\b(408|409|425|429|5\d\d)\b|timeout|timed out|econnreset|econnrefused|fetch failed|network|socket hang up/.test(
    msg,
  );
}

export type StructuredCall<T> = {
  schema: z.ZodType<T>;
  system: string;
  prompt: string;
};

/**
 * 结构化调用：temperature 固定 0，失败不重试超过 1 次（PRD 2.2 抽取规格）。
 * 返回 null 表示不可用或失败 —— 调用方必须走降级路径，不允许抛到用户面前。
 */
export async function generateStructured<T>(
  args: StructuredCall<T>,
  sink?: UsageSink,
): Promise<T | null> {
  const p = client();
  if (!p) return null;
  if (!takeBudget()) return null;
  const promptChars = args.system.length + args.prompt.length;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await generateObject({
        model: chatModel(p),
        schema: args.schema,
        system: args.system,
        prompt: args.prompt,
        temperature: 0,
      });
      sink?.({
        kind: "structured",
        promptChars,
        outputChars: JSON.stringify(res.object ?? null).length,
        ...tokensOf(res.usage),
      });
      return res.object;
    } catch (err) {
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
  if (failed && !emitted) yield* failureNote();
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