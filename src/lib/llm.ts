
import { generateObject, streamText } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import type { z } from "zod";
import { resolvedModelId, resolvedOpenaiKey } from "@/lib/runtime-config";
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
  const hit = clients.get(key);
  if (hit) return hit;
  // 同一把 key 复用实例；表本身要有上限，否则切着玩会把旧 key 赖在内存里。
  if (clients.size > 8) clients.clear();
  const made = createOpenAI({ apiKey: key });
  clients.set(key, made);
  return made;
}

export function llmEnabled(): boolean {
  return Boolean(resolvedOpenaiKey());
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
  const promptChars = args.system.length + args.prompt.length;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await generateObject({
        model: p(resolvedModelId()),
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
export async function* streamSummary(prompt: string, sink?: UsageSink): AsyncGenerator<string> {
  const p = client();
  if (!p) {
    yield* fixtureSummary();
    return;
  }
  let emitted = false;
  let failed = false;
  let outChars = 0;
  try {
    const result = streamText({
      model: p(resolvedModelId()),
      prompt,
      temperature: 0.2,
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