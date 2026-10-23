
import type { Confidence, Field, Intent, ModuleSpec } from "./schemas";

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
  | {
      event: "done";
      data: {
        confidence: number;
        independentSources: number;
        degraded: string[];
        elapsedMs: number;
        stats?: Record<string, number>;
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
