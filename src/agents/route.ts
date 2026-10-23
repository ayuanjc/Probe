
import { IntentSchema, type Intent } from "@/lib/schemas";
import { extractEntities } from "@/lib/entities";
import { generateStructured, llmEnabled } from "@/lib/llm";

/**
 * 意图路由。规则先行 + 模型精修：
 * 规则路径必须永远可用，因为它是无 key 环境下的唯一路径，也是模型抽风时的兜底。
 */

const DAY = 86_400_000;

function windowOf(query: string): { from: string; to: string; days: number } {
  const now = Date.now();
  let days = 30;
  if (/今天|今日|today/i.test(query)) days = 1;
  else if (/本周|这周|一周|7\s*天|this week/i.test(query)) days = 7;
  else if (/近一年|过去一年|一年|12\s*个月|past year/i.test(query)) days = 365;
  else if (/近三月|三个月|季度|3\s*个月|quarter/i.test(query)) days = 90;
  else if (/近半年|半年|6\s*个月|half year/i.test(query)) days = 180;

  return {
    from: new Date(now - days * DAY).toISOString(),
    to: new Date(now).toISOString(),
    days,
  };
}

function kindOf(query: string): Intent["kind"] {
  const q = query.trim();
  if (/怎么看|如何评价|影响|前景|为什么|趋势|格局|意味着|分析|how\s+does|what\s+drives|implications?/i.test(q)) {
    return "exploratory";
  }
  if (/是多少|多少|几|股价|营收|市值|发布日期|谁是|什么时候|how\s+much|when\s+is|who\s+is/i.test(q)) {
    return "lookup";
  }
  // 极短输入不一定是含糊输入。"人工智能"、"英伟达"、"Rust" 都短，
  // 但主体明确、完全可以检索 —— 按长度一刀切会把它们全判成"需要澄清"，
  // 热榜点进来的每个话题都会撞上这堵墙。
  // 只把真正没有检索对象的寒暄/试探挡在这里（PRD 2.1 说的是含糊，不是短）。
  if (q.length < 5) {
    if (/^(你好|您好|哈喽|在吗|在么|测试|试试|hi|hello|hey|test|ping)[\s!！?？。.]*$/i.test(q)) {
      return "no-panel";
    }
    return "exploratory";
  }
  return "exploratory";
}

/* 实体抽取已移到 src/lib/entities.ts：中文查询需要英文别名才能检索 GDELT。 */

export function heuristicIntent(query: string): Intent {
  const kind = kindOf(query);
  const entities = extractEntities(query);
  const ambiguity =
    kind === "no-panel" ? 0.6 : entities.length === 0 ? 0.4 : entities.length > 3 ? 0.4 : 0.12;

  return IntentSchema.parse({
    query,
    kind,
    entities,
    timeRange: { from: windowOf(query).from, to: windowOf(query).to },
    dimensions: ["timeline", "distribution", "kpi"],
    ambiguity,
    language: /[\u4e00-\u9fa5]/.test(query) ? "zh" : "en",
  });
}

export async function routeQuery(query: string): Promise<{ intent: Intent; usedLlm: boolean }> {
  const base = heuristicIntent(query);
  if (!llmEnabled()) return { intent: base, usedLlm: false };

  const refined = await generateStructured<Intent>({
    schema: IntentSchema,
    system:
      "你是情报终端的查询路由。只输出结构化意图，不要解释。" +
      "entities 只放真正可以检索的主体（组织/人物/技术/事件），不要放套话。" +
      "ambiguity 表示该查询本身是否有多种合理解读（0~1）。",
    prompt:
      "用户查询：" + query + "\n" +
      "参考时间窗：" + base.timeRange.from + " ~ " + base.timeRange.to + "\n" +
      "规则初步判断 kind=" + base.kind + "，实体候选=" + JSON.stringify(base.entities) + "。\n" +
      "请给出修正后的意图；若查询过于含糊，把 kind 设为 no-panel 并提高 ambiguity。",
  });

  if (!refined) return { intent: base, usedLlm: false };
  // 模型可能丢掉 query 字段或用占位值，这里以用户原文为准。
  return { intent: { ...refined, query }, usedLlm: true };
}
