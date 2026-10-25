
import type { ProbeEvent, SourceRef } from "@/lib/sse";
import type { Intent } from "@/lib/schemas";
import { llmEnabled, modelId, streamSummary } from "@/lib/llm";
import { regionNotes, resolvedRegion } from "@/lib/runtime-config";
import { endRun, startRun, usageSink } from "@/lib/metrics";
import type { RunRecord, UsageSink } from "@/lib/metrics";
import { isDemoOnly } from "@/lib/confidence";
import { buildEntityGraph } from "@/lib/entity-graph";
import { extractKeyFigures } from "@/lib/key-figures";
import { routeQuery } from "./route";
import { retrieve } from "./retrieve";
import { buildClarify } from "@/lib/polysemy";
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

  if (!query) {
    yield { event: "error", data: { message: "查询为空" } };
    return;
  }

  /**
   * 指标收在这里而不是散在各阶段：生成器无论是走完、提前 return 还是客户端断开，
   * finally 都会被执行。只在"成功"时记录的话，最需要看的那几条（超时、断连、
   * 模型失败）恰好全都不在里面。
   */
  const run = startRun(query);
  const sink = usageSink(run);
  run.llm = llmEnabled();
  run.model = run.llm ? modelId() : null;

  try {
    yield* runStages(query, signal, started, run, sink);
  } finally {
    run.totalMs = Date.now() - started;
    run.aborted = signal?.aborted === true;
    endRun(run);
  }
}

async function* runStages(
  query: string,
  signal: AbortSignal | undefined,
  started: number,
  run: RunRecord,
  sink: UsageSink,
): AsyncGenerator<ProbeEvent> {
  /** 客户端断开后，每个阶段之间都收手：后续的模型调用和上游请求没有接收方。 */
  const gone = () => signal?.aborted === true;

  let stageAt = Date.now();
  const { intent } = await routeQuery(query, sink);
  run.stages.route = Date.now() - stageAt;
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
        notes: ["这条输入没有可检索的主体：流水线在检索前就停了，因此没有任何面板与信源。"],
        elapsedMs: Date.now() - started,
      },
    };
    return;
  }

  /**
   * 澄清卡（PRD 2.1）。以前这里只在摘要里塞一句「存在多种解读」，
   * 用户既看不见到底有哪几种读法，也没有一键改的入口 —— 等于说了句免责声明。
   * 现在把候选读法连同「选了会检索到什么」一起发出去，且不阻塞流水线：
   * 卡片是旁路信息，用户不看，下面的面板照常出。
   */
  const clarify = buildClarify(query, intent);
  if (clarify) yield { event: "intent.clarify", data: clarify };

  stageAt = Date.now();
  const retrieved = await retrieve(intent, signal);
  if (gone()) return;
  run.stages.retrieve = Date.now() - stageAt;

  stageAt = Date.now();
  const analysis = await analyze(intent, retrieved.sources, sink, signal);
  if (gone()) return;
  run.stages.analyze = Date.now() - stageAt;
  run.sources = analysis.sources.length;
  run.owners = analysis.confidence.nOwners;
  run.confidence = analysis.confidence.score;
  run.band = analysis.confidence.band;
  run.notes = analysis.notes.length;
  /**
   * 区域说明也并进来：境内请求会少几个源，界面必须说清是"被规则拦下"而不是"源挂了"。
   * 放在 analyze 之后取，是因为模型调用本身也可能追加一条（endpoint 被换或被拦）。
   */
  const degraded = [...retrieved.degraded, ...analysis.degraded, ...regionNotes()];

  // 全部源都挂了才会走到这里。此时页面仍然有内容，但那些内容是我们自己写的样本。
  // 只把颜色调灰不够——必须用一句话说清楚"这不是事实"，否则这个界面就在骗人。
  const demoOnly = isDemoOnly(retrieved.sources);
  run.demoOnly = demoOnly;
  run.degraded = degraded;
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

  stageAt = Date.now();
  const { plans, specs, errors } = compose(analysis);
  run.stages.compose = Date.now() - stageAt;
  run.modules = specs.length;
  run.moduleErrors = errors.length;

  // 先落骨架，再填内容：用户不会盯着一片空白等模型。
  for (const plan of plans) {
    if (gone()) return;
    yield { event: "module.plan", data: plan };
  }

  /**
   * 面板是聚合结果，没有"某个数字 → 某一条"的映射可给：按日文章数来自 39 篇，
   * 信源分布来自全部 owner。所以这里给的是**本轮证据集**（与信源列表同一个上限），
   * 而不是假装逐条指认。原来切 20 条更糟 —— 信源列了 40 条，卡片只认前 20 条，
   * 读者点开看到的"证据"比下面的列表还少。
   */
  const citeIds = analysis.sources.slice(0, 40).map((s) => s.id);

  for (const spec of specs) {
    if (gone()) return;
    const ds = analysis.datasets.find((d) => d.id === spec.dataset);
    yield {
      event: "module.ready",
      data: {
        id: spec.id,
        spec,
        datasetId: spec.dataset,
        datasetName: ds?.name ?? spec.dataset,
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
          "」的任何判断，也不能被引用。要拿到真实结果，请稍后重试；" +
          (resolvedRegion() === "cn"
            ? "境内访问走的是境内检索，请在 .env 中配置 BOCHA_API_KEY 以提高命中率。\n"
            : "或在 .env 中配置 TAVILY_API_KEY 以提高命中率。\n"),
      },
    };
  } else {
    // 一句都没写出来就是失败（key 无效 / 额度用尽 / 网络不通）。
    // 没有这句话，用户会看到一叠面板配一片空白摘要，然后以为是数据不全。
    let wrote = false;
    stageAt = Date.now();
    /**
     * 客户端走了要真的停：gone() 只是让我们不再往下 yield，
     * 上游那次模型请求还在跑。用 AbortController 把信号传下去，
     * 让它在没人听的时候停下来（否则每条被关掉的页面都在白烧额度）。
     */
    const summaryAbort = new AbortController();
    try {
      const summary = streamSummary(buildPrompt(intent, analysis), sink, summaryAbort.signal);
      for await (const delta of summary) {
        if (gone()) {
          summaryAbort.abort();
          return;
        }
        wrote = true;
        yield { event: "text.delta", data: { delta } };
      }
    } finally {
      summaryAbort.abort();
    }
    run.stages.summary = Date.now() - stageAt;
    if (!wrote) {
      yield {
        event: "text.delta",
        data: {
          delta:
            "摘要没有生成：模型调用失败（key 无效、额度用尽或网络不通）。\n\n" +
            "下面的面板与信源是由本地流水线算出来的，不依赖模型，照常可读。" +
            "若在「设置」里填了自己的 key，请检查它是否有效；清空后会用服务端的配置。\n",
        },
      };
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

  /**
   * 关键数字清单：结果页放在面板网格正下方。
   *
   * 它只搬原文，不下结论 —— 每行是「一个数 + 它的原句 + 说过它的信源」。
   * 模型在线时优先用 claim（指标名干净）；不在线就正则扫 snippet，并在 notes 里说明
   * 这批数字没有经过交叉核对。低置信时再加一条，绝不默默端上一张看起来权威的表。
   */
  const keyFigures = extractKeyFigures({
    sources: analysis.sources,
    claims: analysis.claims,
    confidence: analysis.confidence,
  });
  yield { event: "figures", data: keyFigures };

  /**
   * 共现图要在 sources 之后发：节点里存的是信源 id，前端拿它去刚收到的
   * SourceRef 里换标题与链接。出不了图（实体太散、边太少）就整条不发 ——
   * 与其画一张全是孤立点、看不出结构的图，不如不出现这张卡。
   */
  const graph = buildEntityGraph(analysis.sources, intent.query);
  if (graph.graph) {
    yield { event: "entity.graph", data: graph.graph };
  }

  yield {
    event: "done",
    data: {
      confidence: analysis.confidence.score,
      independentSources: analysis.confidence.nOwners,
      degraded,
      notes: analysis.notes,
      elapsedMs: Date.now() - started,
      stats: retrieved.stats,
      // 断言跟着 done 外发，供结果页的「核验这一轮」按需触发（见 /api/evidence）。
      claims: analysis.claims.slice(0, 30),
    },
  };
}