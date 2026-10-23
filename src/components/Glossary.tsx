"use client";

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { GLOSSARY, type GlossaryKey } from "@/lib/glossary";

/**
 * 术语气泡。
 *
 * 三种方式都能开：hover（鼠标）、focus（键盘）、点击（触屏）——只做 tooltip 会漏掉后两类。
 *
 * 气泡挂在 body 上（portal）+ position: fixed，而不是贴着触发词的 absolute：
 * 1) 卡片是 overflow-hidden，气泡稍长就被卡片切掉；
 * 2) 拖拽网格给每张卡加了 transform，任何祖先的 transform 都会把 fixed 的参照系从视口
 *    改成那块元素，气泡会跟着卡片跑；
 * 3) 触发词可能贴着视口右边或页面底部，纯 CSS 的 left-0 / right-0 只能猜一侧，猜错就溢出。
 *
 * 所以位置是实测的：先渲染（不可见）量出气泡尺寸，夹到视口内；下方放不下就翻到上方。
 * 滚动与窗口缩放时重算——气泡跟着触发词走，不会留在原地。
 */

const GAP = 8; // 气泡与触发词的间距
const EDGE = 8; // 气泡与视口边缘的最小留白
const WIDTH = 300;

export default function Term({
  k,
  children,
  className = "",
  align = "right",
}: {
  k: GlossaryKey;
  children?: React.ReactNode;
  className?: string;
  /** 横向优先贴哪一侧。最终位置会被夹到视口内，所以它只是偏好。 */
  align?: "left" | "right";
}) {
  const entry = GLOSSARY[k];
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const anchorRef = useRef<HTMLSpanElement | null>(null);
  const bubbleRef = useRef<HTMLSpanElement | null>(null);
  const closeTimer = useRef<number | null>(null);
  const id = useId();

  useEffect(() => setMounted(true), []);

  const cancelClose = useCallback(() => {
    if (closeTimer.current !== null) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  }, []);

  // 从触发词移到气泡之间有一段"外面"，立刻关掉就永远点不到气泡里的文字。
  const scheduleClose = useCallback(() => {
    cancelClose();
    closeTimer.current = window.setTimeout(() => setOpen(false), 140);
  }, [cancelClose]);

  useEffect(() => () => cancelClose(), [cancelClose]);

  const place = useCallback(() => {
    const anchor = anchorRef.current;
    const bubble = bubbleRef.current;
    if (!anchor || !bubble) return;

    const a = anchor.getBoundingClientRect();
    const w = bubble.offsetWidth;
    const h = bubble.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    // 触发词滚出视口就别留一个悬空气泡。
    if (a.bottom < -4 || a.top > vh + 4) {
      setOpen(false);
      return;
    }

    let left = align === "right" ? a.right - w : a.left;
    left = Math.min(Math.max(EDGE, left), Math.max(EDGE, vw - EDGE - w));

    let top = a.bottom + GAP;
    if (top + h > vh - EDGE) {
      const above = a.top - GAP - h;
      top = above >= EDGE ? above : Math.max(EDGE, vh - EDGE - h);
    }

    setPos((prev) => (prev && prev.left === left && prev.top === top ? prev : { left, top }));
  }, [align]);

  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    place();
    const onMove = () => place();
    window.addEventListener("resize", onMove);
    window.addEventListener("scroll", onMove, true);
    return () => {
      window.removeEventListener("resize", onMove);
      window.removeEventListener("scroll", onMove, true);
    };
  }, [open, place]);

  // 点开之后点别处要能关掉（触屏上尤其），气泡自己也算"里面"。
  useEffect(() => {
    if (!open) return;
    const onDocDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (anchorRef.current?.contains(t) || bubbleRef.current?.contains(t)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", onDocDown);
    return () => document.removeEventListener("mousedown", onDocDown);
  }, [open]);

  const bubble = (
    <span
      ref={bubbleRef}
      id={id}
      role="tooltip"
      onMouseEnter={cancelClose}
      onMouseLeave={scheduleClose}
      style={{
        position: "fixed",
        left: pos ? pos.left : 0,
        top: pos ? pos.top : 0,
        width: WIDTH,
        maxWidth: "calc(100vw - " + EDGE * 2 + "px)",
        // 首次渲染先隐身：位置要等量完尺寸才知道，露一下会闪。
        visibility: pos ? "visible" : "hidden",
      }}
      className="z-[90] block rounded-lg border border-cyan-500/25 bg-[#08080b]/97 p-3.5 text-left text-[11px] font-normal leading-relaxed text-neutral-400 shadow-[0_24px_70px_-24px_rgba(0,0,0,0.95)]"
    >
      <span className="mb-1 flex items-baseline gap-2">
        <span className="text-[11px] font-semibold tracking-wide text-cyan-300">
          {entry.label}
        </span>
      </span>
      <span className="mb-2 block text-[11px] leading-relaxed text-neutral-300">
        {entry.oneLine}
      </span>
      {entry.body.map((p, i) => (
        <span key={i} className="mb-1.5 block last:mb-0">
          {p}
        </span>
      ))}
      {entry.formula && (
        <span className="mt-2 block rounded border border-white/10 bg-white/[0.04] px-2 py-1 font-mono text-[10px] text-cyan-300/90">
          {entry.formula}
        </span>
      )}
      {entry.caveat && (
        <span className="mt-2 block border-l-2 border-amber-400/40 pl-2 text-[10px] leading-relaxed text-amber-300/80">
          {entry.caveat}
        </span>
      )}
    </span>
  );

  return (
    <span
      ref={anchorRef}
      className={"relative inline-flex items-center " + className}
      onMouseEnter={() => {
        cancelClose();
        setOpen(true);
      }}
      onMouseLeave={scheduleClose}
    >
      <span
        role="button"
        tabIndex={0}
        aria-describedby={open ? id : undefined}
        aria-label={entry.label + "：" + entry.oneLine}
        onClick={() => setOpen((v) => !v)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={(e) => {
          if (e.key === "Escape") setOpen(false);
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setOpen((v) => !v);
          }
        }}
        className="cursor-help underline decoration-dotted decoration-cyan-400/40 decoration-1 underline-offset-[3px] outline-none transition-colors hover:decoration-cyan-300 focus-visible:decoration-cyan-300"
      >
        {children ?? entry.label}
      </span>

      {open && mounted ? createPortal(bubble, document.body) : null}
    </span>
  );
}
