"use client";

const EXAMPLES = [
  "英伟达最近三个月的舆情变化",
  "OpenAI 最新发布的产品是什么",
  "全球电动车销量格局",
];

/**
 * 受控组件：热榜点话题也要把词填进输入框，
 * 否则用户看到结果却不知道"我是用什么问出来的"。
 *
 * 视觉上当命令面板（Command Palette）做：左侧终端提示符、纯黑底、
 * 青色边框只在聚焦时发一次光 —— 整行就是产品的入口。
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
  const submit = () => {
    if (!value.trim() || running) return;
    onRun(value);
  };

  return (
    <div className="w-full">
      <div className="flex items-center gap-3 rounded-2xl border border-cyan-500/30 bg-black/50 px-4 py-3 backdrop-blur-xl transition-all duration-200 focus-within:border-cyan-400 focus-within:shadow-[0_0_15px_rgba(34,211,238,0.2)]">
        <span className="select-none font-mono text-sm font-bold text-cyan-400" aria-hidden>
          ❯
        </span>
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
          }}
          placeholder="问一个需要证据的问题 —— 每个数字都会标注来源"
          className="min-w-0 flex-1 bg-transparent text-sm text-white caret-cyan-400 outline-none placeholder:text-neutral-500"
          spellCheck={false}
        />
        <kbd className="hidden shrink-0 rounded border border-white/10 px-1.5 py-0.5 font-mono text-[10px] text-neutral-500 sm:block">
          ↵
        </kbd>
        <button
          type="button"
          onClick={submit}
          disabled={running || !value.trim()}
          className="shrink-0 rounded-lg border border-cyan-500/30 bg-cyan-500/10 px-3.5 py-1.5 font-mono text-[11px] text-cyan-300 transition-all hover:border-cyan-400/60 hover:bg-cyan-500/20 hover:text-cyan-200 disabled:cursor-not-allowed disabled:border-white/5 disabled:bg-transparent disabled:text-neutral-600"
        >
          {running ? "检索中" : "检索"}
        </button>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-neutral-600">
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
            className="rounded border border-white/10 bg-white/10 px-2 py-0.5 text-[10px] text-neutral-300 transition-colors hover:border-cyan-500/40 hover:bg-cyan-500/10 hover:text-white"
          >
            {q}
          </button>
        ))}
      </div>
    </div>
  );
}
