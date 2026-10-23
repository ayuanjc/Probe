
"use client";

import { useCallback, useRef, useState } from "react";
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
};

export type ProbeState = {
  status: "idle" | "running" | "done" | "failed";
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

  const run = useCallback(async (query: string) => {
    const q = query.trim();
    if (!q) return;

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setState({ ...IDLE, status: "running" });

    try {
      const res = await fetch("/api/search", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: q }),
        signal: controller.signal,
      });

      if (!res.ok || !res.body) {
        throw new Error("检索接口返回 " + res.status);
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
      setState((s) => {
        switch (event.event) {
          case "intent":
            return { ...s, intent: event.data };
          case "text.delta":
            return { ...s, text: s.text + event.data.delta };
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
    setState(IDLE);
  }, []);

  return { state, run, reset };
}
