
"use client";

import { useState } from "react";

const EXAMPLES = [
  "英伟达最近三个月的舆情变化",
  "OpenAI 最新发布的产品是什么",
  "全球电动车销量格局",
];

export default function SearchBar({
  running,
  onRun,
}: {
  running: boolean;
  onRun: (query: string) => void;
}) {
  const [value, setValue] = useState("");

  const submit = () => {
    if (!value.trim() || running) return;
    onRun(value);
  };

  return (
    <div className="w-full">
      <div className="flex items-center gap-2 rounded-lg border border-white/12 bg-[#0b0d11] px-3 py-2 focus-within:border-[#5eead4]/45">
        <span className="select-none text-[#3f4854]">&gt;</span>
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
          }}
          placeholder="问一个需要证据的问题 —— 每个数字都会标注来源"
          className="min-w-0 flex-1 bg-transparent text-[13px] text-[#e2e8f0] outline-none placeholder:text-[#3f4854]"
          spellCheck={false}
        />
        <button
          type="button"
          onClick={submit}
          disabled={running || !value.trim()}
          className="shrink-0 rounded border border-[#5eead4]/35 bg-[#5eead4]/10 px-3 py-1 text-[11px] text-[#5eead4] transition hover:bg-[#5eead4]/18 disabled:cursor-not-allowed disabled:border-white/10 disabled:bg-transparent disabled:text-[#3f4854]"
        >
          {running ? "检索中" : "检索"}
        </button>
      </div>

      <div className="mt-2 flex flex-wrap gap-2">
        {EXAMPLES.map((q) => (
          <button
            key={q}
            type="button"
            onClick={() => {
              setValue(q);
              if (!running) onRun(q);
            }}
            className="rounded border border-white/8 px-2 py-1 text-[10px] text-[#5c6675] transition hover:border-white/20 hover:text-[#94a3b8]"
          >
            {q}
          </button>
        ))}
      </div>
    </div>
  );
}
