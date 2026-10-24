"use client";

import { useMemo, useState } from "react";
import ChartBox from "./ChartBox";
import Term from "./Glossary";
import { neighborhood, type EntityGraph, type EntityNode, type EntityTag } from "@/lib/entity-graph";
import type { SourceRef } from "@/lib/sse";

const TYPE_ZH: Record<EntityTag, string> = {
  org: "机构",
  tech: "技术",
  event: "事件",
  term: "词",
};

const HUB_BLUE = "#3b82f6";
const SOFT_GREY = "#525252";
const WEAK_LINE = "#333333";
const STRONG_LINE = "rgba(59,130,246,0.45)";

type ViewEdge = { a: string; b: string; weight: number };

/**
 * 实体关系图：这一轮信源里「谁和谁一起出现过」。
 *
 * 刻意不做的事：不画有向箭头（共现没有方向）、不写「相关」（那是语义关系，
 * 这里只有同现）、不假装是向量近邻（仓库没有 embedding，2 跳就是共现边的 2 跳）。
 * 点节点只在该实体的 2 跳邻域里看，因为全图一多就成毛球 —— 而毛球不是信息。
 */
export default function EntityGraphCard({
  graph,
  sources,
  collapsed = false,
  onToggle,
}: {
  graph: EntityGraph;
  sources: SourceRef[];
  /** 「收起全部」也会收它：一张还亮着的图夹在一排标题栏中间，像没听指令。 */
  collapsed?: boolean;
  onToggle?: () => void;
}) {
  const [picked, setPicked] = useState<string | null>(null);

  const labels = useMemo(() => {
    const m = new Map<string, string>();
    const used = new Map<string, number>();
    for (const n of graph.nodes) {
      const c = (used.get(n.name) ?? 0) + 1;
      used.set(n.name, c);
      m.set(n.id, c === 1 ? n.name : n.name + "·" + c);
    }
    return m;
  }, [graph]);

  const focus = useMemo(() => {
    if (!picked) return null;
    const hit = graph.nodes.find((n) => n.id === picked);
    if (!hit) return null;
    return { node: hit, area: neighborhood(graph, picked, 2) };
  }, [graph, picked]);

  const nodes = useMemo<EntityNode[]>(() => {
    if (!focus) return graph.nodes;
    const ids = new Set(focus.area.nodes.map((n) => n.id));
    return graph.nodes.filter((n) => ids.has(n.id));
  }, [focus, graph]);

  const edges = useMemo<ViewEdge[]>(() => {
    if (!focus) return graph.edges;
    return focus.area.edges;
  }, [focus, graph]);

  const option = useMemo(() => {
    const degree = new Map<string, number>();
    for (const e of edges) {
      degree.set(e.a, (degree.get(e.a) ?? 0) + 1);
      degree.set(e.b, (degree.get(e.b) ?? 0) + 1);
    }

    const data = nodes.map((n) => {
      const hop = focus ? focus.area.hop[n.id] : undefined;
      const color =
        hop === 0 ? "#ffffff" : hop === 1 ? HUB_BLUE : hop === 2 ? SOFT_GREY : n.mentions >= 2 ? HUB_BLUE : SOFT_GREY;
      const size = 10 + Math.min(18, Math.sqrt(n.mentions) * 7);
      return {
        id: n.id,
        name: labels.get(n.id) ?? n.name,
        value: n.mentions,
        symbolSize: hop === 0 ? size + 6 : size,
        itemStyle: { color, borderColor: "#000", borderWidth: 1 },
        label: { show: true, color: hop === 0 ? "#ffffff" : "#a3a3a3" },
      };
    });

    const links = edges.map((e) => ({
      source: labels.get(e.a) ?? e.a,
      target: labels.get(e.b) ?? e.b,
      value: e.weight,
      lineStyle: {
        color: e.weight >= 2 ? STRONG_LINE : WEAK_LINE,
        width: e.weight >= 2 ? 1.4 : 1,
        type: e.weight >= 2 ? "solid" : "dashed",
        curveness: 0.06,
      },
    }));

    return {
      animationDuration: 240,
      animationEasing: "cubicOut",
      backgroundColor: "transparent",
      tooltip: {
        backgroundColor: "#141414",
        borderColor: "#404040",
        borderWidth: 1,
        textStyle: { color: "#ededed", fontSize: 11 },
        formatter: (p: { dataType?: string; data?: { name?: string; value?: number } }) =>
          p.dataType === "edge"
            ? "共同出现在 " + (p.data?.value ?? 0) + " 条信源里"
            : (p.data?.name ?? "") + " · 出现在 " + (p.data?.value ?? 0) + " 条信源里",
      },
      series: [
        {
          type: "graph",
          layout: "force",
          roam: false,
          draggable: true,
          force: { repulsion: 340, edgeLength: [70, 150], gravity: 0.09, friction: 0.22 },
          symbol: "circle",
          label: { position: "right", fontSize: 11, distance: 5 },
          emphasis: { focus: "adjacency", label: { color: "#ffffff" } },
          data,
          links,
        },
      ],
    };
  }, [edges, focus, labels, nodes]);

  /** 按被提及次数排序的实体 —— 图下的入口按它排，最该点的排最前。 */
  const ranked = useMemo(
    () => [...graph.nodes].sort((a, b) => b.mentions - a.mentions || a.name.localeCompare(b.name)),
    [graph.nodes],
  );

  const evidence = useMemo(() => {
    if (!focus) return [];
    const byId = new Map(sources.map((s) => [s.id, s]));
    return focus.node.sourceIds.map((id) => byId.get(id)).filter((s): s is SourceRef => Boolean(s));
  }, [focus, sources]);

  const neighbors = useMemo(() => {
    if (!focus) return [];
    const byId = new Map(graph.nodes.map((n) => [n.id, n]));
    return edges
      .map((e) => {
        const otherId = e.a === focus.node.id ? e.b : e.a;
        return { node: byId.get(otherId), weight: e.weight, hop: focus.area.hop[otherId] ?? 0 };
      })
      .filter((x): x is { node: EntityNode; weight: number; hop: number } => Boolean(x.node))
      .sort((x, y) => y.weight - x.weight || (x.node.mentions ?? 0) - (y.node.mentions ?? 0));
  }, [edges, focus, graph.nodes]);

  return (
    <section className="panel p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-white">
            <Term k="entityGraph">实体关系图</Term>
          </h2>
          <p className="mt-1 text-[11px] leading-relaxed text-neutral-500">
            边 = 两个词在
            <Term k="cooccur">
              <strong className="font-normal text-neutral-300">同一条标题里同时出现</strong>
            </Term>
            （不是「语义相关」）。点一个节点就只看它 <Term k="twoHop">2 跳</Term> 之内：{graph.nodes.length} 个实体 ·{" "}
            {graph.edges.length} 条共现 · 来自 {graph.sourceCount} 条信源。
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {!collapsed && focus && (
            <button
              type="button"
              onClick={() => setPicked(null)}
              className="rounded-md border border-neutral-800 px-2.5 py-1 text-[11px] text-neutral-400 transition-colors hover:border-neutral-600 hover:text-white"
            >
              返回全图
            </button>
          )}
          {onToggle && (
            <button
              type="button"
              onClick={onToggle}
              aria-expanded={!collapsed}
              aria-label={(collapsed ? "展开" : "收起") + "「实体关系图」"}
              className="cursor-pointer rounded border border-neutral-800 px-1.5 py-0.5 font-mono text-[10px] leading-none text-neutral-500 transition-colors hover:border-neutral-600 hover:text-white"
            >
              <span aria-hidden>{collapsed ? "▸" : "▾"}</span>
            </button>
          )}
        </div>
      </div>

      {!collapsed && (
        <>
      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 font-mono text-[10px] text-neutral-600">
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-2 w-2 rounded-full bg-blue-500" />
          强共现（≥2 条）
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-2 w-2 rounded-full bg-neutral-600" />
          只同现 1 次
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-px w-4 bg-neutral-700" />
          虚线 = 只有一条信源作为依据
        </span>
      </div>

      {/*
        ECharts 的容器高度必须能算成确定值：它的 canvas 用 height:100%，
        而 100% 只对「高度已定」的父元素生效。这里父级是普通块（不是 flex 列），
        只给 min-height 会让百分比失效、canvas 退到默认 100px ——
        所以套一层定高 flex 列，让 ChartBox 的 flex-1 拿得到实际高度。
      */}
      <div className="mt-2 flex h-[360px] flex-col">
      <ChartBox
        option={option}
        minHeight={340}
        onEvents={{
          click: (params: never) => {
            const p = params as { dataType?: string; data?: { id?: string } };
            if (p.dataType !== "node" || !p.data?.id) return;
            setPicked((prev) => (prev === p.data?.id ? null : (p.data?.id as string)));
          },
        }}
      />
      </div>

      {focus ? (
        <div className="mt-3 grid gap-4 border-t border-neutral-800 pt-3 md:grid-cols-2">
          <div>
            <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-neutral-600">
              {focus.node.name}
              <span className="ml-1.5 normal-case tracking-normal text-neutral-500">
                {TYPE_ZH[focus.node.type]} · 出现在 {focus.node.mentions} 条信源里
              </span>
            </div>
            <p className="mt-1.5 text-[11px] leading-relaxed text-neutral-500">
              <Term k="twoHop">2 跳</Term> 之内还有 {Math.max(0, focus.area.nodes.length - 1)} 个实体、{neighbors.length} 条边
              {focus.area.omitted > 0 ? "（超出上限的 " + focus.area.omitted + " 个已折叠）" : ""}
              。
            </p>
            <ul className="mt-2 flex flex-wrap gap-1.5">
              {neighbors.map((n) => (
                <li key={n.node.id}>
                  <button
                    type="button"
                    onClick={() => setPicked(n.node.id)}
                    className="rounded border border-neutral-800 px-2 py-0.5 font-mono text-[10px] text-neutral-400 transition-colors hover:border-neutral-600 hover:text-white"
                  >
                    {labels.get(n.node.id) ?? n.node.name}
                    <span className="ml-1 text-neutral-600">×{n.weight}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
          <div>
            <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-neutral-600">
              证据来源
            </div>
            <ul className="mt-1.5 space-y-1.5">
              {evidence.length === 0 && (
                <li className="text-[11px] text-neutral-600">该实体来自已折叠的信源，本轮没有可展开的条目。</li>
              )}
              {evidence.map((s) => (
                <li key={s.id} className="text-[11px] leading-relaxed">
                  <a
                    href={s.url}
                    target="_blank"
                    rel="noreferrer"
                    className="line-clamp-2 text-neutral-400 transition-colors hover:text-white"
                  >
                    {s.title}
                  </a>
                  <span className="ml-1.5 font-mono text-[10px] text-neutral-600">{s.owner}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      ) : (
        <div className="mt-3 border-t border-neutral-800 pt-3">
          <p className="text-[11px] leading-relaxed text-neutral-600">
            节点越大 = 被提到的信源越多。点任意节点，只看它 2 跳之内的邻域与证据来源；再点一次或点「返回全图」回到全景。
          </p>
          {/*
            画布上的圆点键盘到不了、读屏也念不出，所以在图下面给一排同样的入口：
            这是画布交互的无障碍兜底，不是第二套导航。
          */}
          <ul className="mt-2 flex flex-wrap gap-1.5">
            {ranked.slice(0, 6).map((n) => (
              <li key={n.id}>
                <button
                  type="button"
                  onClick={() => setPicked(n.id)}
                  className="rounded border border-neutral-800 px-2 py-0.5 font-mono text-[10px] text-neutral-400 transition-colors hover:border-neutral-600 hover:text-white"
                >
                  {labels.get(n.id) ?? n.name}
                  <span className="ml-1 text-neutral-600">×{n.mentions}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
        </>
      )}
    </section>
  );
}
