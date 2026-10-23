
import type { ProbeEvent, SourceRef } from "@/lib/sse";
import type { Intent } from "@/lib/schemas";
import { streamSummary } from "@/lib/llm";
import { routeQuery } from "./route";
import { retrieve } from "./retrieve";
import { analyze } from "./analyze";
import { compose } from "./compose";

/**
 * 编排：route -> retrieve -> analyze -> compose。显式异步流水线，
 * 每一步都把降级信息往前带，最终出现在 done 事件里（PRD 附录 A）。
 */

const MAX_QUERY = 300;

function buildPrompt(intent: Intent, analysis: Awaited<ReturnType<typeof analyze>>): string {
  const rows = analysis.datasets
    .filter((d) => d.id !== "ds-summary")
    .map((d) => d.name + ": " + JSON.stringify(d.rows.slice(0, 12)))
    .join("\n");

  return (
    "你是情报终端的数据摘要器。基于下面这些已经核验过的结构化数据写 3~5 句中文摘要。" +
    "硬约束：只能引用给定数字；不要推断因果；不要给建议；不确定就说不确定。" +
    "若置信度为低档，只说“证据不足”，不复述任何聚合数字。\n" +
    "查询：" + intent.query + "\n" +
    "置信度：" + analysis.confidence.score + "（" + analysis.confidence.band + "），独立信源 " + analysis.confidence.nOwners + " 个\n" +
    "数据：\n" + rows
  );
}

export async function* runPipeline(rawQuery: string): AsyncGenerator<ProbeEvent> {
  const started = Date.now();
  const query = rawQuery.trim().slice(0, MAX_QUERY);

  if (!query) {
    yield { event: "error", data: { message: "查询为空" } };
    return;
  }

  const { intent } = await routeQuery(query);
  yield { event: "intent", data: intent };

  if (intent.ambiguity > 0.35) {
    yield {
      event: "text.delta",
      data: {
        delta:
          "这条查询存在多种解读，下面按最宽口径先给一版面板；你可以补充主体或时间范围再收窄。\n\n",
      },
    };
  }

  const retrieved = await retrieve(intent);
  const analysis = await analyze(intent, retrieved.sources);
  const degraded = [...retrieved.degraded, ...analysis.degraded];

  const { plans, specs, errors } = compose(analysis);

  // 先落骨架，再填内容：用户不会盯着一片空白等模型。
  for (const plan of plans) {
    yield { event: "module.plan", data: plan };
  }

  for (const spec of specs) {
    const err = errors.find((e) => e.id === spec.id);
    const ds = analysis.datasets.find((d) => d.id === spec.dataset);
    yield {
      event: "module.ready",
      data: {
        id: spec.id,
        spec,
        datasetId: spec.dataset,
        rows: ds?.rows ?? [],
        fields: ds?.fields ?? [],
        sources: err ? [] : analysis.sources.slice(0, 20).map((s) => s.id),
        confidence: analysis.confidence.score,
      },
    };
  }

  for (const err of errors) {
    yield {
      event: "module.error",
      data: {
        id: err.id,
        reason: "semantic_invalid",
        fallback: "table",
        detail: err.error.reason,
      },
    };
  }

  const summary = streamSummary(buildPrompt(intent, analysis));
  for await (const delta of summary) {
    yield { event: "text.delta", data: { delta } };
  }

  const sourceRefs: SourceRef[] = analysis.sources.slice(0, 40).map((s) => ({
    id: s.id,
    title: s.title,
    url: s.url,
    owner: s.owner,
    publishedAt: s.publishedAt,
    syndicated: analysis.syndicatedIds.includes(s.id),
    quote: analysis.claims.find((c) => c.sourceIds.includes(s.id))?.quote,
  }));

  yield { event: "sources", data: { sources: sourceRefs, confidence: analysis.confidence } };

  yield {
    event: "done",
    data: {
      confidence: analysis.confidence.score,
      independentSources: analysis.confidence.nOwners,
      degraded,
      elapsedMs: Date.now() - started,
      stats: retrieved.stats,
    },
  };
}
