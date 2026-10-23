"use client";

import { useEffect, useRef } from "react";

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
 */
export default function SearchBar({
  running,
  value,
  onChange,
  onRun,
}: {
  running: boolean;
  value: string;
  onChange: (value: string) => void;
  onRun: (query: string) => void;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);

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
      <div className="flex items-center gap-3 rounded-md border border-neutral-800 bg-[#0f0f0f] px-4 py-3 transition-colors focus-within:border-neutral-600">
        <svg
          aria-hidden
          viewBox="0 0 16 16"
          className="h-4 w-4 shrink-0 text-neutral-600"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
          strokeLinecap="round"
        >
          <circle cx="7" cy="7" r="4.25" />
          <path d="m10.4 10.4 3.1 3.1" />
        </svg>
        <input
          ref={inputRef}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
          }}
          placeholder="问一个需要证据的问题 —— 每个数字都会标注来源"
          className="min-w-0 flex-1 bg-transparent text-sm text-white caret-blue-500 outline-none placeholder:text-neutral-600"
          spellCheck={false}
        />
        <kbd
          title="按 / 聚焦搜索框"
          className="hidden shrink-0 rounded border border-neutral-800 px-1.5 py-0.5 font-mono text-[10px] text-neutral-600 sm:block"
        >
          /
        </kbd>
        <kbd className="hidden shrink-0 rounded border border-neutral-800 px-1.5 py-0.5 font-mono text-[10px] text-neutral-600 sm:block">
          ↵
        </kbd>
        <button
          type="button"
          onClick={submit}
          disabled={running || !value.trim()}
          className="shrink-0 rounded-md bg-blue-600 px-3.5 py-1.5 text-[11px] font-medium text-white transition-colors hover:bg-blue-500 disabled:cursor-not-allowed disabled:bg-neutral-800 disabled:text-neutral-600"
        >
          {running ? "检索中" : "检索"}
        </button>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
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
            className="rounded border border-neutral-800 px-2.5 py-1 text-[11px] text-neutral-500 transition-colors hover:border-neutral-600 hover:text-neutral-300"
          >
            {q}
          </button>
        ))}
      </div>
    </div>
  );
}
