"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import ModulePrompt from "./ModulePrompt";
import type { ModuleState } from "@/hooks/useProbe";
import type { Dataset } from "@/lib/schemas";

/**
 * 侧栏里的「DIY」圆钮：一句话生成面板收在这个按钮后面（PRD 2.5）。
 *
 * 面板用 portal + fixed 定位，和术语解释是同一个理由：侧栏带 overflow-y-auto，
 * 面板挂在里面会被裁；网格卡片上的 transform 还会把 fixed 的包含块从视口改成卡片。
 * 位置按按钮的实测矩形算：右对齐按钮右边（侧栏贴右，面板落在内侧而不是屏幕外），
 * 下方放不下就上翻，两边都放不下就夹进视口。按钮滚出视口时直接收起来。
 */

const EDGE = 8;
const GAP = 12;
const PANEL_W = 340;

type Props = {
  /** 这一轮真实产出的数据集（带完整 rows，用于编译校验）。 */
  datasets: Dataset[];
  modules: ModuleState[];
  confidence: number;
  sourceIds: string[];
  headers: Record<string, string>;
  onAdd: (m: ModuleState) => void;
  status: "idle" | "running" | "done" | "failed";
};

export default function ModuleDock({
  datasets,
  modules,
  confidence,
  sourceIds,
  headers,
  onAdd,
  status,
}: Props) {
  const ready = status === "done" && datasets.length > 0;
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number; width: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  const place = useCallback(() => {
    // 锚点用整块入口（与侧栏同宽 340），而不是 64px 的圆钮：
    // 右对齐圆钮右边会让 340 宽的面板往左偏出侧栏、盖住结果区。
    const anchor = anchorRef.current;
    const panel = panelRef.current;
    if (!anchor || !panel) return;
    const a = anchor.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    // 按钮滚出视口后浮层已经没有锚点，收起来比钉在角落更诚实。
    if (a.bottom < -4 || a.top > vh + 4) {
      setOpen(false);
      return;
    }
    const w = Math.min(PANEL_W, vw - EDGE * 2);
    let left = a.right - w;
    left = Math.min(Math.max(EDGE, left), Math.max(EDGE, vw - EDGE - w));
    const h = panel.offsetHeight;
    let top = a.bottom + GAP;
    if (top + h > vh - EDGE) {
      const up = a.top - GAP - h;
      top = up >= EDGE ? up : Math.max(EDGE, vh - EDGE - h);
    }
    setPos({ left, top, width: w });
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
      btnRef.current?.focus();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const hint =
    status === "done"
      ? datasets.length > 0
        ? "点开就能加一张：只说想看什么，字段由注册表挑"
        : "这一轮没有能出图的数据集"
      : status === "running"
        ? "检索中：拿到数据之后才能出图"
        : status === "failed"
          ? "上一轮失败了：重试拿到数据后才能出图"
          : "先搜一个问题：生成器只挑这一轮算出来的数据";

  return (
    <div ref={anchorRef} className="panel flex items-center gap-4 p-4">
      <button
        ref={btnRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label="打开一句话生成面板"
        className="group relative flex h-16 w-16 shrink-0 cursor-pointer items-center justify-center rounded-full border border-cyan-500/40 bg-cyan-500/[0.06] transition-[border-color,background-color,box-shadow] hover:border-cyan-400 hover:bg-cyan-500/[0.12] hover:shadow-[0_0_26px_-6px_rgba(34,211,238,0.65)]"
      >
        <span className="font-mono text-[11px] font-bold tracking-[0.14em] text-cyan-200">
          DIY
        </span>
        <span
          aria-hidden
          className="pointer-events-none absolute inset-[3px] rounded-full border border-cyan-400/15 transition-colors group-hover:border-cyan-300/40"
        />
      </button>
      <div className="min-w-0">
        <p className="text-sm font-semibold text-white">一句话生成面板</p>
        <p className="mt-1 font-mono text-[10px] leading-relaxed text-neutral-600">{hint}</p>
        {ready && (
          <p className="mt-1 font-mono text-[10px] tabular-nums text-cyan-400/80">
            {datasets.length} 份数据可挑
          </p>
        )}
      </div>

      {open &&
        createPortal(
          <div
            ref={panelRef}
            role="dialog"
            aria-label="面板生成器"
            className="fixed z-[60]"
            style={{
              left: pos ? pos.left : 0,
              top: pos ? pos.top : 0,
              width: pos ? pos.width : PANEL_W,
              // 先只隐身不卸载：量高度要靠它仍然参与布局。
              visibility: pos ? "visible" : "hidden",
            }}
          >
            {ready ? (
              <ModulePrompt
                datasets={datasets}
                modules={modules}
                confidence={confidence}
                sourceIds={sourceIds}
                headers={headers}
                onAdd={onAdd}
              />
            ) : (
              <div className="panel p-4">
                <p className="text-sm font-semibold text-white">一句话生成面板</p>
                <p className="mt-2 font-mono text-[10px] leading-relaxed text-neutral-600">
                  {hint}
                </p>
                <p className="mt-3 font-mono text-[10px] leading-relaxed text-neutral-700">
                  Esc 或点击别处关闭
                </p>
              </div>
            )}
          </div>,
          document.body,
        )}
    </div>
  );
}
