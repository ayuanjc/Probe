
import type { EntityGraph } from "./entity-graph";
import type { ClarifyPayload } from "./polysemy";
import type { Claim, Confidence, Field, Intent, ModuleSpec } from "./schemas";

/**
 * SSE 事件契约（PRD 附录 A）。
 * 必须是单一连接上的多路事件：多个 fetch 无法保证顺序，也无法与文本流对齐。
 */

export type SourceRef = {
  id: string;
  title: string;
  url: string;
  owner: string;
  publishedAt: string;
  syndicated: boolean;
  quote?: string;
};

export type ModuleErrorReason =
  | "schema_invalid"
  | "semantic_invalid"
  | "source_unavailable";

export type ProbeEvent =
  | { event: "intent"; data: Intent }
  /**
   * 歧义澄清卡（PRD 2.1）。紧跟在 intent 之后、检索之前发出：
   * 卡片的成本必须低到不拖慢检索，所以它只带「这个词有哪几种读法」，
   * 不阻塞流水线 —— 用户不看也不会卡住后面的模块。
   */
  | { event: "intent.clarify"; data: ClarifyPayload }
  | { event: "text.delta"; data: { delta: string } }
  | {
      event: "module.plan";
      data: { id: string; kind: ModuleSpec["kind"]; title: string; w: number; h: number };
    }
  | {
      event: "module.ready";
      data: {
        id: string;
        spec: ModuleSpec;
        datasetId: string;
        /** 数据集的中文名。前端拿它重建 Dataset 元信息，供「一句话生成模块」使用。 */
        datasetName: string;
        rows: Record<string, string | number | null>[];
        fields: Field[];
        sources: string[];
        confidence: number;
      };
    }
  | {
      event: "module.error";
      data: { id: string; reason: ModuleErrorReason; fallback: "table" | "none"; detail?: string };
    }
  | { event: "sources"; data: { sources: SourceRef[]; confidence: Confidence } }
  /**
   * 实体共现图。放在 sources 之后、done 之前：它带着每条边的信源 id，
   * 前端的「证据来源」要拿这些 id 去 sources 里查标题与链接。
   */
  | { event: "entity.graph"; data: EntityGraph }
  | {
      event: "done";
      data: {
        confidence: number;
        independentSources: number;
        degraded: string[];
        /**
         * 口径说明。以前这些只活在服务端 notes 里、从不外发，
         * 于是"已抑制聚合数字""文章数指本次命中"这些话用户一句都看不到。
         */
        notes: string[];
        elapsedMs: number;
        stats?: Record<string, number>;
        /**
         * 本轮抽到的断言（带 quote）。发到前端不是为了让界面直接显示它们 ——
         * 是为了让「核验这一轮」能在用户点的时候单独发一次请求：
         * 核验要跑十几次上游、几十秒，不能挂在首屏的 SSE 上等人。
         */
        claims?: Claim[];
      };
    }
  | { event: "error"; data: { message: string } };

export function encodeEvent(e: ProbeEvent): string {
  return `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`;
}

/** 浏览器端解码：把一个 SSE chunk 拆成事件数组。 */
export function decodeChunk(buffer: string): { events: ProbeEvent[]; rest: string } {
  const parts = buffer.split("\n\n");
  const rest = parts.pop() ?? "";
  const events: ProbeEvent[] = [];

  for (const block of parts) {
    let eventName = "message";
    const dataLines: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) eventName = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
    }
    if (dataLines.length === 0) continue;
    try {
      events.push({ event: eventName, data: JSON.parse(dataLines.join("\n")) } as ProbeEvent);
    } catch {
      // 半个 JSON 不可能是合法事件；丢弃即可，流末会由 done 兜底。
    }
  }
  return { events, rest };
}
