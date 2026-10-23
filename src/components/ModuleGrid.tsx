
"use client";

import "react-grid-layout/css/styles.css";

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { GridLayout, useContainerWidth, type LayoutItem } from "react-grid-layout";
import type { ModuleState } from "@/hooks/useProbe";
import type { SourceRef } from "@/lib/sse";
import {
  GRID_COLS,
  GRID_MARGIN,
  GRID_ROW_HEIGHT,
  autoLayout,
  clearLayout,
  loadLayout,
  saveLayout,
} from "@/lib/layout";
import ModuleCard from "./ModuleCard";

/** 小屏不做拖拽：12 列在这个宽度下每列不到 40px，拖出来的位置没有意义。 */
const GRID_MIN_WIDTH = 720;

/**
 * 模块网格（PRD 2.5）。
 *
 * PRD 附录 A 第 2 条：顺序由流决定，用户拖出来的布局不能被中途到达的
 * module.ready 打断，所以**流式期间锁定拖拽**，done 之后才解锁。
 *
 * 锁定不是靠 CSS pointer-events 假装，而是真的把 drag/resize 关掉：
 * 半透明的拖拽把手上写着"禁用"，用户还是会去拖。
 */
function ModuleGrid({
  modules,
  sources,
  query,
  running,
}: {
  modules: ModuleState[];
  sources: SourceRef[];
  query: string;
  running: boolean;
}) {
  const { width, containerRef, mounted } = useContainerWidth({
    measureBeforeMount: true,
    debounceTimeout: 120,
  });

  const [layout, setLayout] = useState<LayoutItem[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [saveFailed, setSaveFailed] = useState(false);

  /** 只在模块集合真的变了才重排；streaming 期间每次 render 都重算会把拖拽状态冲掉。 */
  const signature = modules.map((m) => m.id + ":" + m.w + "x" + m.h).join("|");
  const idsRef = useRef<string[]>([]);
  idsRef.current = modules.map((m) => m.id);

  const defaults = useMemo(
    () => autoLayout(modules.map((m) => ({ id: m.id, w: m.w, h: m.h }))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [signature],
  );

  useEffect(() => {
    if (modules.length === 0) {
      setLayout([]);
      setNotice(null);
      return;
    }
    const loaded = loadLayout(query, defaults);
    setLayout(loaded.items);
    setNotice(loaded.notice);
  }, [signature, query, defaults, modules.length]);

  const unlocked = !running && modules.length > 0;

  /**
   * 拖拽/缩放期间给 <body> 挂一个标记：
   * 卡片上的外发光阴影、发丝光过渡在指针每动一次时都会重绘整张卡（阴影是昂贵的
   * 大范围模糊）。松手再恢复，观感上只是"手里那张卡更亮"，但每帧省下一次全卡重绘。
   */
  useEffect(() => {
    const mark = (on: boolean) => document.body.classList.toggle("grid-interacting", on);
    return () => {
      mark(false);
    };
  }, []);

  const commit = useCallback(
    (next: readonly LayoutItem[]) => {
      setLayout([...next]);
      if (!query.trim()) return;
      const ok = saveLayout(query, [...next], idsRef.current);
      setSaveFailed(!ok);
    },
    [query],
  );

  const reset = useCallback(() => {
    clearLayout(query);
    setLayout(defaults);
    setNotice("已回到默认排布，并清除了本机快照。");
    setSaveFailed(false);
  }, [defaults, query]);

  if (modules.length === 0) return null;

  // SSR / 首次测量前：先按顺序铺一遍，避免和水合后的网格位置对不上。
  if (!mounted || width < GRID_MIN_WIDTH) {
    return (
      <div className="flex flex-col gap-6" ref={containerRef}>
        {width > 0 && width < GRID_MIN_WIDTH && (
          <div className="px-1 font-mono text-[10px] text-neutral-600">
            窗口较窄：卡片单列排布，拖拽已停用。
          </div>
        )}
        {modules.map((m) => (
          <ModuleCard key={m.id} module={m} sources={sources} />
        ))}
      </div>
    );
  }

  return (
    <div ref={containerRef} className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-2 px-1 font-mono text-[10px] text-neutral-600">
        <span>
          {unlocked
            ? "可拖拽卡片标题调整位置、拖右下角改尺寸；布局按查询词存在本机。"
            : "结果生成中：布局已锁定，done 之后可拖拽。"}
          {notice && <span className="ml-2 text-neutral-500">{notice}</span>}
          {saveFailed && <span className="ml-2 text-amber-400">本机存储写入失败，布局不会被记住。</span>}
        </span>
        {unlocked && (
          <button
            type="button"
            onClick={reset}
            className="cursor-pointer rounded border border-white/10 bg-white/[0.04] px-2.5 py-0.5 text-[10px] text-neutral-300 transition-colors hover:border-cyan-500/40 hover:bg-cyan-500/10 hover:text-white"
          >
            重置布局
          </button>
        )}
      </div>

      <GridLayout
        width={width}
        layout={layout}
        gridConfig={{
          cols: GRID_COLS,
          rowHeight: GRID_ROW_HEIGHT,
          margin: [GRID_MARGIN, GRID_MARGIN],
          containerPadding: [0, 0],
        }}
        dragConfig={{
          enabled: unlocked,
          // 只有标题栏可以拖：图表里的 tooltip 与拖拽抢指针是最烦人的一类交互 bug。
          handle: ".card-drag-handle",
          cancel: "a, button, summary, input, select",
          threshold: 3,
        }}
        resizeConfig={{ enabled: unlocked, handles: ["se", "sw"] }}
        onDragStart={() => document.body.classList.add("grid-interacting")}
        onDragStop={(next) => {
          document.body.classList.remove("grid-interacting");
          commit(next);
        }}
        onResizeStart={() => document.body.classList.add("grid-interacting")}
        onResizeStop={(next) => {
          document.body.classList.remove("grid-interacting");
          commit(next);
        }}
      >
        {modules.map((m) => (
          <div key={m.id} className="h-full">
            <ModuleCard module={m} sources={sources} draggable={unlocked} />
          </div>
        ))}
      </GridLayout>
    </div>
  );
}

/**
 * 流式期间摘要每帧更新，Workspace 每帧重渲染。没有 memo 时整个网格（以及
 * react-grid-layout 内部的布局计算）都跟着跑一遍，虽然每张卡自己已经 memo 过。
 * 这里挡在网格外面：modules / sources 的引用在流式期间不变，网格直接跳过。
 */
export default memo(ModuleGrid);