
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { decodeChunk, type ProbeEvent, type SourceRef } from "@/lib/sse";
import type { Confidence, Field, Intent, ModuleSpec } from "@/lib/schemas";

export type ModuleState = {
  id: string;
  kind: ModuleSpec["kind"];
  title: string;
  w: number;
  h: number;
  status: "plan" | "ready" | "error";
  spec?: ModuleSpec;
  rows?: Record<string, string | number | null>[];
  fields?: Field[];
  confidence?: number;
  errorDetail?: string;
  /** 该模块数字对应的原文 id，用于"两次点击回到原文"（PRD 附录 C）。 */
  sourceIds?: string[];
};

export type ProbeState = {
  status: "idle" | "running" | "done" | "failed";
  /** 产生这批模块的查询词 —— 布局快照按它做键，不能拿输入框里的当前值。 */
  query: string;
  intent: Intent | null;
  text: string;
  modules: ModuleState[];
  sources: SourceRef[];
  confidence: Confidence | null;
  degraded: string[];
  elapsedMs: number | null;
  error: string | null;
};

const IDLE: ProbeState = {
  status: "idle",
  query: "",
  intent: null,
  text: "",
  modules: [],
  sources: [],
  confidence: null,
  degraded: [],
  elapsedMs: null,
  error: null,
};

export function useProbe() {
  const [state, setState] = useState<ProbeState>(IDLE);
  const abortRef = useRef<AbortController | null>(null);

  /**
   * 流式合帧：text.delta 一个 token 一次 setState，等于一个 token 一次整树重渲染。
   * 模型正常吐字 30–80 token/s，那就是 30–80 次/秒的 React 协调 —— 摘要框每加一个字，
   * 下面所有图表卡都要跟着走一遍 render。实测流式期间最长 94ms 的长动画帧就出在这里。
   * 所以把 delta 攒进 ref，按帧（rAF）提交一次；其它事件到达时先把它冲掉，保证顺序。
   */
  const pendingText = useRef("");
  const rafRef = useRef<number | null>(null);

  const cancelFlush = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  }, []);

  const flushText = useCallback(() => {
    cancelFlush();
    const add = pendingText.current;
    if (!add) return;
    pendingText.current = "";
    setState((s) => ({ ...s, text: s.text + add }));
  }, [cancelFlush]);

  const queueText = useCallback(
    (delta: string) => {
      pendingText.current += delta;
      if (rafRef.current !== null) return;
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null;
        flushText();
      });
    },
    [flushText],
  );

  // 组件卸载后还在跑 rAF 会往已卸载的 state 里写。
  useEffect(() => () => cancelFlush(), [cancelFlush]);

  const run = useCallback(async (query: string) => {
    const q = query.trim();
    if (!q) return;

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setState({ ...IDLE, status: "running", query: q });

    try {
      const res = await fetch("/api/search", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: q }),
        signal: controller.signal,
      });

      if (!res.ok || !res.body) {
        /**
         * 429 的 body 里有"请 N 秒后重试"。直接抛 HTTP 状态码的话，
         * 用户只会看到"检索接口返回 429"——他知道出错了，但不知道该等多久。
         */
        const detail = await res
          .json()
          .then((b: unknown) => {
            const msg = (b as { message?: string })?.message;
            return typeof msg === "string" ? msg : "";
          })
          .catch(() => "");
        throw new Error(detail || "检索接口返回 " + res.status);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parsed = decodeChunk(buffer);
        buffer = parsed.rest;
        for (const event of parsed.events) applyEvent(event);
      }
      flushText();
      setState((s) => (s.status === "running" ? { ...s, status: "done" } : s));
    } catch (err) {
      if (controller.signal.aborted) return;
      setState((s) => ({
        ...s,
        status: "failed",
        error: err instanceof Error ? err.message : "请求失败",
      }));
    }

    function applyEvent(event: ProbeEvent) {
      if (event.event === "text.delta") {
        queueText(event.data.delta);
        return;
      }
      // 非文本事件要先落盘已攒的文本，否则摘要顺序会颠倒（例如 done 先于最后一段字）。
      flushText();
      setState((s) => {
        switch (event.event) {
          case "intent":
            return { ...s, intent: event.data };
          case "module.plan":
            return {
              ...s,
              modules: [
                ...s.modules.filter((m) => m.id !== event.data.id),
                { ...event.data, status: "plan" },
              ],
            };
          case "module.ready":
            return {
              ...s,
              modules: s.modules.map((m) =>
                m.id === event.data.id
                  ? {
                      ...m,
                      status: "ready",
                      spec: event.data.spec,
                      rows: event.data.rows,
                      fields: event.data.fields,
                      confidence: event.data.confidence,
                      sourceIds: event.data.sources,
                    }
                  : m,
              ),
            };
          case "module.error":
            return {
              ...s,
              modules: s.modules.map((m) =>
                m.id === event.data.id
                  ? { ...m, status: "error", errorDetail: event.data.detail ?? event.data.reason }
                  : m,
              ),
            };
          case "sources":
            return { ...s, sources: event.data.sources, confidence: event.data.confidence };
          case "done":
            return {
              ...s,
              status: "done",
              degraded: event.data.degraded,
              elapsedMs: event.data.elapsedMs,
            };
          case "error":
            return { ...s, status: "failed", error: event.data.message };
          default:
            return s;
        }
      });
    }
  }, []);

  const reset = useCallback(() => {
    abortRef.current?.abort();
    cancelFlush();
    pendingText.current = "";
    setState(IDLE);
  }, [cancelFlush]);

  return { state, run, reset };
}
