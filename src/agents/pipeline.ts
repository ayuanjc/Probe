
import type { ProbeEvent, SourceRef } from "@/lib/sse";
import type { Intent } from "@/lib/schemas";
import { streamSummary } from "@/lib/llm";
import { isDemoOnly } from "@/lib/confidence";
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
    "若置信度为低档，只说“证据不足”，不复述任何聚合数字；若数据来自演示样本，先说那些不是实时抓取的结果。\n" +
    "查询：" + intent.query + "\n" +
    "置信度：" + analysis.confidence.score + "（" + analysis.confidence.band + "），独立信源 " + analysis.confidence.nOwners + " 个\n" +
    "数据：\n" + rows
  );
}

export async function* runPipeline(
  rawQuery: string,
  signal?: AbortSignal,
): AsyncGenerator<ProbeEvent> {
  const started = Date.now();
  const query = rawQuery.trim().slice(0, MAX_QUERY);
  /** 客户端断开后，每个阶段之间都收手：后续的模型调用和上游请求没有接收方。 */
  const gone = () => signal?.aborted === true;

  if (!query) {
    yield { event: "error", data: { message: "查询为空" } };
    return;
  }

  const { intent } = await routeQuery(query);
  if (gone()) return;
  yield { event: "intent", data: intent };

  /**
   * no-panel 是"这条输入压根不是情报问题"（打招呼、闲聊、无主体），
   * 此前它照样走完整条流水线，于是"你好"会换来一张 KPI 卡 ——
   * 面板的存在本身就在暗示"这里有事可讲"，而实际上什么都没有。
   * 早退，只回一句提示。
   */
  if (intent.kind === "no-panel") {
    yield {
      event: "text.delta",
      data: {
        delta:
          "这条输入不是一个可获得证据支持的情报问题。请给出具体主体（公司/产品/人物）与时间范围，" +
          "例如「英伟达最近三个月的舆情变化」。\n\n",
      },
    };
    yield {
      event: "done",
      data: {
        confidence: 0,
        independentSources: 0,
        degraded: [],
        elapsedMs: Date.now() - started,
      },
    };
    return;
  }

  if (intent.ambiguity > 0.35) {
    yield {
      event: "text.delta",
      data: {
        delta:
          "这条查询存在多种解读，下面按最宽口径先给一版面板；你可以补充主体或时间范围再收窄。\n\n",
      },
    };
  }

  const retrieved = await retrieve(intent, signal);
  if (gone()) return;
  const analysis = await analyze(intent, retrieved.sources);
  if (gone()) return;
  const degraded = [...retrieved.degraded, ...analysis.degraded];

  // 全部源都挂了才会走到这里。此时页面仍然有内容，但那些内容是我们自己写的样本。
  // 只把颜色调灰不够——必须用一句话说清楚"这不是事实"，否则这个界面就在骗人。
  const demoOnly = isDemoOnly(retrieved.sources);
  if (demoOnly) {
    yield {
      event: "text.delta",
      data: {
        delta:
          "本轮所有实时信源都未返回结果，下面展示的是本地演示样本而非真实抓取。" +
          "样本只用来验证渲染链路，不能作为任何判断的依据。\n\n",
      },
    };
  }

  const { plans, specs, errors } = compose(analysis);

  // 先落骨架，再填内容：用户不会盯着一片空白等模型。
  for (const plan of plans) {
    if (gone()) return;
    yield { event: "module.plan", data: plan };
  }

  const citeIds = analysis.sources.slice(0, 20).map((s) => s.id);

  for (const spec of specs) {
    if (gone()) return;
    const ds = analysis.datasets.find((d) => d.id === spec.dataset);
    yield {
      event: "module.ready",
      data: {
        id: spec.id,
        spec,
        datasetId: spec.dataset,
        rows: ds?.rows ?? [],
        fields: ds?.fields ?? [],
        /**
         * 降级成 table 的模块同样是"数字"，同样必须能点回原文。
         * 之前这里写的是 err ? [] : ...，等于把降级模块的溯源一并抹掉 ——
         * 越是不确定的数字，越需要能核对。
         */
        sources: citeIds,
        confidence: analysis.confidence.score,
      },
    };
  }

  for (const err of errors) {
    if (gone()) return;
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

  /**
   * 演示样本不进模型。只靠在 prompt 里叮嘱"记得说这不是实时结果"是不牢靠的：
   * 模型看到一整套结构良好的数字，最自然的动作就是复述它们，
   * 而读者只会记住结论，不会记住那句免责声明。
   * 这里直接不给模型机会，改由这里写死的事实说明替代。
   */
  if (demoOnly) {
    const names = analysis.datasets
      .filter((d) => d.id !== "ds-summary")
      .map((d) => "「" + d.name + "」")
      .join("");
    yield {
      event: "text.delta",
      data: {
        delta:
          "本轮没有任何实时命中，面板里的" +
          (names || "全部内容") +
          "全部来自本地演示样本，是渲染链路的占位数据。它们不构成对「" +
          intent.query +
          "」的任何判断，也不能被引用。要拿到真实结果，请稍后重试，或在 .env 中配置 TAVILY_API_KEY 以提高命中率。\n",
      },
    };
  } else {
    const summary = streamSummary(buildPrompt(intent, analysis));
    for await (const delta of summary) {
      if (gone()) return;
      yield { event: "text.delta", data: { delta } };
    }
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