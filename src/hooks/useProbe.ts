
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { decodeChunk, type ProbeEvent, type SourceRef } from "@/lib/sse";
import type { Confidence, Field, Intent, ModuleSpec } from "@/lib/schemas";
import type { EntityGraph } from "@/lib/entity-graph";
import { MODULE_SIZE } from "@/lib/module-catalog";

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
  /** 这份数据的中文名（如「信源分布」）。前端靠它重建 Dataset，供自定义模块使用。 */
  datasetName?: string;
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
  /** 本轮信源的实体共现图；出不了图时是 null（界面上那张卡就不出现）。 */
  entityGraph: EntityGraph | null;
  degraded: string[];
  /** 后端对口径的补充说明（例如「低置信：聚合数字已抑制」）。 */
  notes: string[];
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
  entityGraph: null,
  degraded: [],
  notes: [],
  elapsedMs: null,
  error: null,
};

export function useProbe() {
  const [state, setState] = useState<ProbeState>(IDLE);
  const abortRef = useRef<AbortController | null>(null);
  /**
   * 轮次令牌：两次检索的响应可能交错落地（用户连点、或第一次还没读完就换了词）。
   * 只有"当前这一轮"允许写 state —— 否则上一轮迟到的 sources / done 会把新答案覆盖掉，
   * 或者把刚开始的新一轮直接标成 done。
   */
  const seqRef = useRef(0);

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

  /**
   * 卸载后还在跑的 rAF 与流都要停掉，但不能「一卸载就 abort」。
   *
   * 开发模式的 StrictMode 会在挂载后立刻卸载再挂载一次，而首页「带 ?q= 自启一轮」的
   * effect 用 booted ref 只发一次 —— 如果在第一次卸载时就 abort，那条请求会被杀掉，
   * 而 booted 已经是 true，第二次挂载不会再发，页面就永远停在「检索中」。
   * 所以卸载后延到下一个宏任务再决定：仍在挂载（说明是 StrictMode 抖动）就不动它。
   */
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      window.setTimeout(() => {
        if (mountedRef.current) return;
        abortRef.current?.abort();
        abortRef.current = null;
        cancelFlush();
        pendingText.current = "";
      }, 0);
    };
  }, [cancelFlush]);

  /**
   * extraHeaders 用来随请求带上「设置」里用户自己的 key。
   * 走请求头而不是查询串：查询串会进服务端访问日志、也会留在浏览器历史里。
   */
  const run = useCallback(async (query: string, extraHeaders?: Record<string, string>) => {
    const q = query.trim();
    if (!q) return;

    abortRef.current?.abort();
    cancelFlush();
    pendingText.current = "";
    const controller = new AbortController();
    abortRef.current = controller;
    const seq = ++seqRef.current;
    /** 本轮是否仍然是"当前轮"：换轮、重置、卸载都会让它为假。 */
    const current = () => seqRef.current === seq && abortRef.current === controller;

    setState({ ...IDLE, status: "running", query: q });

    try {
      const res = await fetch("/api/search", {
        method: "POST",
        headers: { "content-type": "application/json", ...(extraHeaders ?? {}) },
        body: JSON.stringify({ query: q }),
        signal: controller.signal,
      });

      if (!current()) return;

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
        if (!current()) return;
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parsed = decodeChunk(buffer);
        buffer = parsed.rest;
        for (const event of parsed.events) applyEvent(event);
      }

      /**
       * 收尾：解码器可能还压着半个多字节字符，缓冲区也可能剩最后一个事件块
       * （代理截断、或服务端末条事件没以空行收尾）。以前直接 break 会把 done 丢掉，
       * 界面就永远停在"检索中"。所以补一个换行再解析一次。
       */
      buffer += decoder.decode();
      if (buffer.trim()) {
        for (const event of decodeChunk(buffer + "\n\n").events) applyEvent(event);
      }
      if (!current()) return;
      flushText();
      setState((s) => (s.status === "running" ? { ...s, status: "done" } : s));
    } catch (err) {
      if (controller.signal.aborted || !current()) return;
      setState((s) => ({
        ...s,
        status: "failed",
        error: err instanceof Error ? err.message : "请求失败",
      }));
    }

    function applyEvent(event: ProbeEvent) {
      if (!current()) return;
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
              // 找不到对应的 plan 就补一条，而不是把它丢掉 —— 丢掉的模块等于少画一张图。
              modules: s.modules.some((m) => m.id === event.data.id)
                ? s.modules.map((m) =>
                    m.id === event.data.id
                      ? {
                          ...m,
                          status: "ready",
                          spec: event.data.spec,
                          rows: event.data.rows,
                          fields: event.data.fields,
                          confidence: event.data.confidence,
                          sourceIds: event.data.sources,
                          datasetName: event.data.datasetName,
                        }
                      : m,
                  )
                : [
                    ...s.modules,
                    {
                      id: event.data.id,
                      kind: event.data.spec.kind,
                      title: event.data.spec.title,
                      // 尺寸不在 spec 里（spec 只说画什么），要按注册表补，否则这张卡是 0×0。
                      w: MODULE_SIZE[event.data.spec.kind].w,
                      h: MODULE_SIZE[event.data.spec.kind].h,
                      status: "ready",
                      spec: event.data.spec,
                      rows: event.data.rows,
                      fields: event.data.fields,
                      confidence: event.data.confidence,
                      sourceIds: event.data.sources,
                      datasetName: event.data.datasetName,
                    },
                  ],
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
          case "entity.graph":
            return { ...s, entityGraph: event.data };
          case "done":
            return {
              ...s,
              status: "done",
              degraded: event.data.degraded,
              notes: event.data.notes ?? [],
              elapsedMs: event.data.elapsedMs,
            };
          case "error":
            return { ...s, status: "failed", error: event.data.message };
          default:
            return s;
        }
      });
    }
  }, [cancelFlush, flushText, queueText]);

  const reset = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    seqRef.current += 1;
    cancelFlush();
    pendingText.current = "";
    setState(IDLE);
  }, [cancelFlush]);

  /**
   * 「一句话生成模块」的落点：把一张已经编译通过的卡片塞进网格。
   * 它不改 status、不碰 text —— 生成模块不该让整页表现成"又在检索"。
   * 换查询时会被 run() 的 setState({...IDLE}) 一并清掉，这符合直觉：
   * 自定义面板引用的数据集来自上一轮，换了问题就不适用了。
   */
  const addModule = useCallback((m: ModuleState) => {
    setState((s) =>
      s.modules.some((x) => x.id === m.id)
        ? { ...s, modules: s.modules.map((x) => (x.id === m.id ? m : x)) }
        : { ...s, modules: [...s.modules, m] },
    );
  }, []);

  return { state, run, reset, addModule };
}
