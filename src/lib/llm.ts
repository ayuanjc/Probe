
import { generateObject, streamText } from "ai";
import { openai } from "@ai-sdk/openai";
import type { z } from "zod";

/**
 * LLM 适配层。所有模型调用都收敛在这一个文件里，理由有二：
 *   1. 没有 API key 时全链路仍然可跑（fixture 兜底），developer 不需要 credentials 才能看到界面；
 *   2. 换 provider / 换 SDK 版本时只改这里。
 */

export const MODEL_ID = process.env.PROBE_MODEL ?? "gpt-4.1-mini";

export function llmEnabled(): boolean {
  return Boolean(process.env.OPENAI_API_KEY);
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
): Promise<T | null> {
  if (!llmEnabled()) return null;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { object } = await generateObject({
        model: openai(MODEL_ID),
        schema: args.schema,
        system: args.system,
        prompt: args.prompt,
        temperature: 0,
      });
      return object;
    } catch (err) {
      if (attempt === 1) {
        console.warn("[llm] structured call failed:", err instanceof Error ? err.message : err);
      }
    }
  }
  return null;
}

/** 摘要流式输出。无 key 时用可读的降级文本，保证 UI 永远有东西可流。 */
export async function* streamSummary(prompt: string): AsyncGenerator<string> {
  if (!llmEnabled()) {
    yield* fixtureSummary();
    return;
  }
  try {
    const result = streamText({
      model: openai(MODEL_ID),
      prompt,
      temperature: 0.2,
    });
    for await (const delta of result.textStream) {
      yield delta;
    }
  } catch (err) {
    console.warn("[llm] stream failed:", err instanceof Error ? err.message : err);
    yield* fixtureSummary();
  }
}

function* fixtureSummary(): Generator<string> {
  const text =
    "已按意图拆分并完成多源检索。当前运行在 fixture 模式（未配置 OPENAI_API_KEY），" +
    "因此摘要由本地模板生成，数字与图表均来自真实抓取或本地样本。" +
    "配置 key 后此段将由模型流式生成。";
  // 片段太长会让前端每个事件都重渲染一次，太碎则事件数爆炸；14 字是折中值。
  for (let i = 0; i < text.length; i += 14) {
    yield text.slice(i, i + 14);
  }
}
