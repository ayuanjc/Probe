"use client";

import { useEffect, useId, useRef, useState } from "react";
import { GLOSSARY, type GlossaryKey } from "@/lib/glossary";

/**
 * 术语气泡。用 hover + focus + 点击三种方式都能开：
 * 触屏没有 hover，键盘用户没有鼠标，只做 tooltip 会漏掉这两类人。
 */
export default function Term({
  k,
  children,
  className = "",
  align = "right",
}: {
  k: GlossaryKey;
  children?: React.ReactNode;
  className?: string;
  align?: "left" | "right";
}) {
  const entry = GLOSSARY[k];
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLSpanElement | null>(null);
  const id = useId();

  // 点开之后点别处要能关掉，否则触屏上气泡会一直挡着。
  useEffect(() => {
    if (!open) return;
    const onDocDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDocDown);
    return () => document.removeEventListener("mousedown", onDocDown);
  }, [open]);

  return (
    <span
      ref={wrapRef}
      className={"relative inline-flex items-center " + className}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
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

      {open && (
        <span
          id={id}
          role="tooltip"
          className={
            "absolute top-full z-50 mt-2 block w-[300px] rounded-lg border border-cyan-500/25 bg-[#08080b]/97 p-3.5 text-left text-[11px] font-normal leading-relaxed text-neutral-400 shadow-[0_24px_70px_-24px_rgba(0,0,0,0.95)] backdrop-blur-xl " +
            (align === "right" ? "right-0" : "left-0")
          }
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
      )}
    </span>
  );
}
