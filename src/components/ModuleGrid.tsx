
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
 * 收起后的行高。2 行 = 2×28 + 24 间距 = 80px，刚好容下标题栏（pt-4 + 标题 + pb-2）。
 * 收起不是「隐藏内容但仍占住位置」：网格高度真的塌下来，后面的卡才会上移。
 */
const COLLAPSED_H = 2;

/**
 * 操作提示可以关掉，且记住关掉这件事（probe: 前缀会跟「一键还原」一起被清掉）。
 * 提示本身只在第一次见到时有用，常驻就成了噪音。
 */
const HINT_KEY = "probe:grid-hint:v1";
const HINT_TEXT = "拖动标题把手 ⠿ 移动卡片 · 右下角手柄改尺寸 · 布局按查询词存在本机";

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
  animation = true,
  gap = GRID_MARGIN,
  onCollapseAll,
}: {
  modules: ModuleState[];
  sources: SourceRef[];
  query: string;
  running: boolean;
  /** 设置里的「图表入场动画」开关。关掉时图表直接出终态，省一次逐帧重绘。 */
  animation?: boolean;
  /** 卡片间距（px）：紧凑 16 / 标准 24。 */
  gap?: number;
  /** 「收起全部 / 展开全部」时通知外层（实体关系图不在网格里，但它也是图表）。 */
  onCollapseAll?: (allCollapsed: boolean) => void;
}) {
  const { width, containerRef, mounted } = useContainerWidth({
    measureBeforeMount: true,
    debounceTimeout: 120,
  });

  const [layout, setLayout] = useState<LayoutItem[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [saveFailed, setSaveFailed] = useState(false);
  const [hintOpen, setHintOpen] = useState(true);

  /**
   * 收起的是「看」，不是「存」：collapsed 只影响渲染用的行高，layout 里始终保留展开时的
   * 真实 h。所以展开能原样复原，快照也不会被收起状态污染（下次打开仍是展开的）。
   */
  const [collapsed, setCollapsed] = useState<string[]>([]);
  const collapsedRef = useRef<Set<string>>(new Set());
  collapsedRef.current = new Set(collapsed);

  // 关掉的提示不该在刷新后又冒出来；localStorage 不可用时只当这次会话有效。
  useEffect(() => {
    try {
      setHintOpen(window.localStorage.getItem(HINT_KEY) !== "off");
    } catch {
      /* 隐私模式下读不了存储：按默认显示，功能不受影响。 */
    }
  }, []);

  const dismissHint = useCallback(() => {
    setHintOpen(false);
    try {
      window.localStorage.setItem(HINT_KEY, "off");
    } catch {
      /* 同上：存不下来就算了，不假装存好了。 */
    }
  }, []);

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

  /** 渲染用的布局：收起的卡压到标题栏高度。minH/maxH 一起压，否则 RGL 会按原高度撑回去。 */
  const renderLayout = useMemo(
    () =>
      layout.map((it) =>
        collapsedRef.current.has(it.i)
          ? { ...it, h: COLLAPSED_H, minH: COLLAPSED_H, maxH: COLLAPSED_H }
          : it,
      ),
    [layout, collapsed],
  );

  const anyExpanded = modules.some((m) => !collapsedRef.current.has(m.id));

  const toggleOne = useCallback((id: string) => {
    setCollapsed((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }, []);

  const toggleAll = useCallback(() => {
    const next = collapsed.length > 0 ? [] : modules.map((m) => m.id);
    setCollapsed(next);
    setNotice(null);
    onCollapseAll?.(next.length > 0);
  }, [collapsed.length, modules, onCollapseAll]);

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
      // 收起中的卡在 RGL 眼里只有 2 行高；拿这个值落盘会把「展开后的高度」永久丢掉。
      const merged = layout.map((item) => {
        const n = next.find((v) => v.i === item.i);
        if (!n) return item;
        const keepH = collapsedRef.current.has(item.i);
        return { ...item, x: n.x, y: n.y, w: n.w, h: keepH ? item.h : n.h };
      });
      setLayout(merged);
      if (!query.trim()) return;
      const ok = saveLayout(query, merged, idsRef.current);
      setSaveFailed(!ok);
    },
    [layout, query],
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
      <div className="flex flex-col gap-4" ref={containerRef}>
        {width > 0 && width < GRID_MIN_WIDTH && (
          <div className="px-1 font-mono text-[10px] text-neutral-600">
            窗口较窄：卡片单列排布，拖拽已停用。
          </div>
        )}
        {modules.map((m) => (
          <ModuleCard
            key={m.id}
            module={m}
            sources={sources}
            animation={animation}
            collapsed={collapsedRef.current.has(m.id)}
            onToggle={() => toggleOne(m.id)}
          />
        ))}
      </div>
    );
  }

  return (
    <div ref={containerRef} className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2 px-1 font-mono text-[10px] text-neutral-600">
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          {unlocked ? (
            hintOpen ? (
              <>
                <span>{HINT_TEXT}</span>
                <button
                  type="button"
                  onClick={dismissHint}
                  aria-label="收起操作提示"
                  className="cursor-pointer px-1 text-neutral-600 transition-colors hover:text-neutral-300"
                >
                  ×
                </button>
              </>
            ) : null
          ) : (
            <span>结果生成中：布局已锁定，完成之后可拖拽。</span>
          )}
          {notice && <span className="text-neutral-500">{notice}</span>}
          {saveFailed && <span className="text-yellow-500">本机存储写入失败，布局不会被记住。</span>}
        </span>
        <span className="flex items-center gap-2">
          {modules.length > 1 && (
            <button
              type="button"
              onClick={toggleAll}
              aria-label={anyExpanded ? "收起全部图表" : "展开全部图表"}
              className="cursor-pointer rounded border border-neutral-800 px-2.5 py-0.5 text-[10px] text-neutral-400 transition-colors hover:border-neutral-600 hover:text-white"
            >
              {anyExpanded ? "收起全部" : "展开全部"}
            </button>
          )}
          {unlocked && (
            <button
              type="button"
              onClick={reset}
              className="cursor-pointer rounded border border-neutral-800 px-2.5 py-0.5 text-[10px] text-neutral-400 transition-colors hover:border-neutral-600 hover:text-white"
            >
              重置布局
            </button>
          )}
        </span>
      </div>

      <GridLayout
        width={width}
        layout={renderLayout}
        gridConfig={{
          cols: GRID_COLS,
          rowHeight: GRID_ROW_HEIGHT,
          margin: [gap, gap],
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
            <ModuleCard
              module={m}
              sources={sources}
              draggable={unlocked}
              animation={animation}
              collapsed={collapsedRef.current.has(m.id)}
              onToggle={() => toggleOne(m.id)}
            />
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