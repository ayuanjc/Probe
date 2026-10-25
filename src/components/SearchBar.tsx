"use client";

import { useEffect, useRef } from "react";
import { ArrowRight, Search } from "lucide-react";
import VisitorRegion from "@/components/VisitorRegion";

const EXAMPLES = [
  "英伟达最近三个月的舆情变化",
  "OpenAI 最新发布的产品是什么",
  "全球电动车销量格局",
];

/**
 * 受控组件：热榜点话题也要把词填进输入框，
 * 否则用户看到结果却不知道"我是用什么问出来的"。
 *
 * 视觉上当一行干净的输入：纯黑底、1px 灰边框、左侧一枚细灰放大镜，
 * 聚焦只把边框提亮一档（不发光）。整行就是产品的入口。
 *
 * size="lg" 给首页那一版用，size="sm" 给结果页顶部那一行用 ——
 * 同一个组件、同一份状态，由外层的布局动画负责「从居中到顶栏」这段过渡，
 * 所以这里不做任何动画（两套 DOM 各自飞会互相打架）。
 */
export default function SearchBar({
  running,
  value,
  onChange,
  onRun,
  size = "sm",
  autoFocus = false,
}: {
  running: boolean;
  value: string;
  onChange: (value: string) => void;
  onRun: (query: string) => void;
  size?: "sm" | "lg";
  autoFocus?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const lg = size === "lg";

  const submit = () => {
    if (!value.trim() || running) return;
    onRun(value);
  };

  // 斜杠聚焦搜索框（GitHub / Linear 那一套）：页面随时可以开始打字，
  // 但正在别的输入框里打字时不要把光标抢走。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      const tag = t?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || t?.isContentEditable) return;
      e.preventDefault();
      inputRef.current?.focus();
      inputRef.current?.select();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="w-full">
      <div
        className={[
          "flex items-center border border-neutral-800 bg-[#0f0f0f] transition-colors focus-within:border-neutral-600",
          lg ? "gap-3 rounded-lg px-4 py-3" : "gap-3 rounded-md px-4 py-2.5",
        ].join(" ")}
      >
        <Search aria-hidden className="h-4 w-4 shrink-0 text-neutral-600" strokeWidth={1.25} />
        <input
          ref={inputRef}
          value={value}
          autoFocus={autoFocus}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
          }}
          aria-label="检索"
          placeholder="问一个需要证据的问题 —— 每个数字都会标注来源"
          enterKeyHint="search"
          autoComplete="off"
          autoCapitalize="off"
          className={[
            "min-w-0 flex-1 bg-transparent text-[16px] text-white caret-blue-500 outline-none placeholder:text-neutral-600 sm:text-[15px]",
            lg ? "" : "sm:text-sm",
          ].join(" ")}
          spellCheck={false}
        />
        {lg && (
          <>
            <kbd
              title="按 / 聚焦搜索框"
              className="hidden shrink-0 rounded border border-neutral-800 px-1.5 py-0.5 font-mono text-[10px] text-neutral-600 sm:block"
            >
              /
            </kbd>
            <kbd className="hidden shrink-0 rounded border border-neutral-800 px-1.5 py-0.5 font-mono text-[10px] text-neutral-600 sm:block">
              ↵
            </kbd>
          </>
        )}
        {/* 幽灵按钮：没有底色，hover 只把字与箭头提亮。入口的视觉权重落在输入行本身。 */}
        <button
          type="button"
          onClick={submit}
          disabled={running || !value.trim()}
          className={[
            "flex shrink-0 items-center gap-1 font-mono text-neutral-500 transition-colors hover:text-white disabled:cursor-not-allowed disabled:text-neutral-700 disabled:hover:text-neutral-700",
            lg ? "text-xs" : "text-[11px]",
          ].join(" ")}
        >
          {running ? "检索中…" : "检索"}
          {!running && <ArrowRight aria-hidden className="h-3.5 w-3.5" strokeWidth={1.5} />}
        </button>
      </div>

      {/* 示例只在首页出现：结果页顶栏那一行是常驻控件，摆一排快捷词会把整行撑高。 */}
      {lg && <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
        <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-neutral-600">
          试试
        </span>
        {EXAMPLES.map((q) => (
          <button
            key={q}
            type="button"
            onClick={() => {
              onChange(q);
              if (!running) onRun(q);
            }}
            className={(lg ? "px-3 py-1" : "px-2.5 py-0.5") + " rounded-full bg-neutral-900 text-xs text-neutral-400 transition-colors hover:bg-neutral-800 hover:text-white"}
          >
            {q}
          </button>
        ))}
      </div>}

      {/* 属地说明挂在「试试」下面、整块右对齐：只在首页那一版出现，
          结果页顶栏保持一行干净控件。 */}
      {lg && <VisitorRegion />}
    </div>
  );
}
