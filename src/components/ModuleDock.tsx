"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import ModulePrompt from "./ModulePrompt";
import { anchorVisible, placeFloating } from "@/lib/placement";
import type { ModuleState } from "@/hooks/useProbe";
import type { Dataset } from "@/lib/schemas";

/**
 * 侧栏里唯一的键：DIY。一句话生成是它的下级内容（PRD 2.5）。
 *
 * 侧栏只放一个键、而不是一张说明卡：侧栏是工具区不是引导页，一张常驻的大卡会
 * 持续和结果抢注意力；一根 40px 高的键点开就是全部内容，收起后什么都不占。
 *
 * 只在这一轮真的跑完、并且有可出图的数据集时才由 Workspace 渲染 —— 检索过程中
 * 侧栏连占位都不出现（渐进披露：主视图先给结果，专业工具按需出现）。
 *
 * 面板用 portal + fixed 定位，和术语解释同一个理由：侧栏带 overflow-y-auto，
 * 面板挂在里面会被裁；网格卡片上的 transform 还会把 fixed 的包含块从视口改成卡片。
 * 落点算术在 @/lib/placement。锚点用整块入口（与侧栏同宽）而不是 64px 圆钮：
 * 右对齐圆钮会让 340 宽的面板往左偏出侧栏、盖住结果区。
 *
 * 整块入口都是按钮（不是只有圆钮）：用户第一眼看到的是说明文字，点文字也该打开。
 */

const PANEL_W = 340;
const GAP = 12;

type Props = {
  /** 这一轮真实产出的数据集（带完整 rows，用于编译校验）。 */
  datasets: Dataset[];
  modules: ModuleState[];
  confidence: number;
  sourceIds: string[];
  headers: Record<string, string>;
  onAdd: (m: ModuleState) => void;
  /** 新卡片入网格后把视线带过去（Workspace 负责滚动 + 高亮）。 */
  onReveal?: (id: string) => void;
};

export default function ModuleDock({
  datasets,
  modules,
  confidence,
  sourceIds,
  headers,
  onAdd,
  onReveal,
}: Props) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number; width: number } | null>(null);
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  const place = useCallback(() => {
    const anchor = anchorRef.current;
    const panel = panelRef.current;
    if (!anchor || !panel) return;

    const rect = anchor.getBoundingClientRect();
    // 入口滚出视口后浮层已经没有锚点，收起来比钉在角落更诚实。
    if (!anchorVisible(rect, window.innerHeight)) {
      setOpen(false);
      return;
    }

    setPos(
      placeFloating({
        anchor: rect,
        panel: { width: panel.offsetWidth, height: panel.offsetHeight },
        viewport: { width: window.innerWidth, height: window.innerHeight },
        align: "right",
        maxWidth: PANEL_W,
        gap: GAP,
      }),
    );
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    place();
    const onChange = () => place();
    window.addEventListener("scroll", onChange, true);
    window.addEventListener("resize", onChange);
    return () => {
      window.removeEventListener("scroll", onChange, true);
      window.removeEventListener("resize", onChange);
    };
  }, [open, place]);

  // 打开后把焦点交给输入框：这个浮层里唯一的动作就是打字。
  useEffect(() => {
    if (!open) return;
    const id = window.setTimeout(() => {
      panelRef.current?.querySelector<HTMLInputElement>("input")?.focus();
    }, 60);
    return () => window.clearTimeout(id);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (anchorRef.current?.contains(t) || panelRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={anchorRef}>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label="打开 DIY 面板"
        className="panel group flex w-full cursor-pointer items-center justify-between gap-3 px-3.5 py-2.5 text-left transition-colors hover:border-neutral-600"
      >
        <span className="font-mono text-xs font-bold uppercase tracking-[0.2em] text-white">
          DIY
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-[10px] tabular-nums text-neutral-500">
          {datasets.length} 份数据 · 一句话生成
        </span>
        <span
          aria-hidden
          className="shrink-0 font-mono text-[10px] text-neutral-600 transition-colors group-hover:text-white"
        >
          {open ? "收起 ›" : "点开 ›"}
        </span>
      </button>

      {open &&
        createPortal(
          <div
            ref={panelRef}
            role="dialog"
            aria-label="面板生成器"
            className="rise fixed z-[60]"
            style={{
              left: pos ? pos.left : 0,
              top: pos ? pos.top : 0,
              width: pos ? pos.width : PANEL_W,
              // 先只隐身不卸载：量高度要靠它仍然参与布局。
              visibility: pos ? "visible" : "hidden",
            }}
          >
            <ModulePrompt
              datasets={datasets}
              modules={modules}
              confidence={confidence}
              sourceIds={sourceIds}
              headers={headers}
              onAdd={onAdd}
              onReveal={(id) => {
                setOpen(false);
                onReveal?.(id);
              }}
            />
          </div>,
          document.body,
        )}
    </div>
  );
}
