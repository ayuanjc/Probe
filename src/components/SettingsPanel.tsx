"use client";

import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import {
  DEFAULT_SETTINGS,
  THEMES,
  isCustomized,
  resetLocalData,
  type Settings,
} from "@/lib/settings";

function Group({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="border-t border-white/[0.07] px-6 py-5">
      <h3 className="text-[13px] font-semibold tracking-wide text-white">{title}</h3>
      {hint && <p className="mt-1 text-[11px] leading-relaxed text-neutral-500">{hint}</p>}
      <div className="mt-4 space-y-4">{children}</div>
    </section>
  );
}

function Label({ children }: { children: ReactNode }) {
  return (
    <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-neutral-500">
      {children}
    </span>
  );
}

const INPUT_CLASS =
  "w-full rounded-lg border border-white/10 bg-black/50 px-3 py-2 font-mono text-[12px] " +
  "text-neutral-200 outline-none transition-[border-color,box-shadow] " +
  "placeholder:text-neutral-700 focus:border-[color:var(--accent)]/60";

function Secret({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
}) {
  const [show, setShow] = useState(false);
  return (
    <div className="flex items-center gap-2">
      <input
        type={show ? "text" : "password"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        spellCheck={false}
        autoComplete="off"
        className={INPUT_CLASS}
      />
      <button
        type="button"
        onClick={() => setShow((v) => !v)}
        className="shrink-0 rounded-lg border border-white/10 px-2.5 py-2 font-mono text-[10px] text-neutral-500 transition-colors hover:border-white/20 hover:text-neutral-300"
      >
        {show ? "隐藏" : "显示"}
      </button>
    </div>
  );
}

function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-lg border px-3 py-1.5 font-mono text-[11px] transition-colors"
      style={{
        borderColor: active ? "var(--accent)" : "rgba(255,255,255,0.1)",
        color: active ? "var(--accent)" : "rgb(163,163,163)",
        background: active ? "rgba(255,255,255,0.04)" : "transparent",
      }}
    >
      {children}
    </button>
  );
}

function Toggle({
  on,
  onChange,
  label,
}: {
  on: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={() => onChange(!on)}
      className="flex items-center gap-2.5"
    >
      <span
        className="relative h-4 w-7 rounded-full transition-colors"
        style={{ background: on ? "var(--accent)" : "rgba(255,255,255,0.14)" }}
      >
        <span
          className="absolute top-0.5 h-3 w-3 rounded-full bg-[#050507] transition-all"
          style={{ left: on ? "14px" : "2px" }}
        />
      </span>
      <span className="text-[12px] text-neutral-300">{label}</span>
    </button>
  );
}

export default function SettingsPanel({
  open,
  settings,
  onChange,
  onClose,
}: {
  open: boolean;
  settings: Settings;
  onChange: (next: Settings) => void;
  onClose: () => void;
}) {
  const [armed, setArmed] = useState(false);

  useEffect(() => {
    if (!open) {
      setArmed(false);
      return;
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // 确认态会自己过期：晾在那里十分钟再点，等于没有二次确认。
  useEffect(() => {
    if (!armed) return;
    const t = window.setTimeout(() => setArmed(false), 4000);
    return () => window.clearTimeout(t);
  }, [armed]);

  if (!open) return null;

  function patch(p: Partial<Settings>) {
    onChange({ ...settings, ...p });
  }

  function doReset() {
    resetLocalData();
    onChange({ ...DEFAULT_SETTINGS });
    // 布局快照也清掉了，回到干净的首页比原地刷新更彻底。
    window.location.href = window.location.pathname;
  }

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <button
        type="button"
        aria-label="关闭设置"
        onClick={onClose}
        className="absolute inset-0 bg-black/60 backdrop-blur-[2px]"
      />
      <aside
        role="dialog"
        aria-modal="true"
        aria-label="设置"
        className="scroll-thin relative flex h-full w-full max-w-[440px] flex-col overflow-y-auto border-l border-white/10 bg-[#07080a] shadow-[-30px_0_80px_-40px_rgba(0,0,0,0.9)]"
      >
        <header className="sticky top-0 z-10 flex items-center justify-between gap-3 border-b border-white/[0.07] bg-[#07080a]/95 px-6 py-4">
          <div>
            <h2 className="text-base font-semibold text-white">设置</h2>
            <p className="mt-0.5 font-mono text-[10px] text-neutral-600">
              改动即时生效 · 只存本机
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-white/10 px-2.5 py-1 font-mono text-[11px] text-neutral-400 transition-colors hover:border-white/25 hover:text-white"
          >
            ESC
          </button>
        </header>

        <Group
          title="自己的 API 密钥"
          hint="填了就用你的：服务端不再看自己的 env。留空则沿用服务端配置。"
        >
          <div className="space-y-1.5">
            <Label>OpenAI key</Label>
            <Secret
              value={settings.openaiKey}
              onChange={(v) => patch({ openaiKey: v })}
              placeholder="sk-…（意图精修 / 断言抽取 / 摘要 / 翻译）"
            />
          </div>
          <div className="space-y-1.5">
            <Label>Tavily key</Label>
            <Secret
              value={settings.tavilyKey}
              onChange={(v) => patch({ tavilyKey: v })}
              placeholder="tvly-…（网页检索；没填就只走免密钥的 HN / Wikipedia）"
            />
          </div>
          <div className="space-y-1.5">
            <Label>模型</Label>
            <input
              type="text"
              value={settings.model}
              onChange={(e) => patch({ model: e.target.value })}
              placeholder="留空 = gpt-4.1-mini"
              spellCheck={false}
              autoComplete="off"
              className={INPUT_CLASS}
            />
          </div>
          <p className="rounded-lg border border-amber-400/20 bg-amber-400/[0.05] px-3 py-2.5 text-[11px] leading-relaxed text-amber-300/80">
            key 存在这台浏览器的 localStorage 里，每次检索 / 翻译时随请求头发给本服务，
            服务端只在这一轮请求里用它调上游 —— 不写数据库、不写日志、不跨请求复用。
            换台设备或清站点数据就没了。
          </p>
        </Group>

        <Group title="外观" hint="改的是 html 上的 data 属性与根字号，不碰任何组件。">
          <div className="flex items-center justify-between gap-3">
            <Label>主题色</Label>
            <div className="flex gap-2">
              {THEMES.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => patch({ theme: t.id })}
                  aria-label={t.label}
                  className="h-6 w-6 rounded-full border transition-transform hover:scale-110"
                  style={{
                    background: t.swatch,
                    borderColor: settings.theme === t.id ? "#fff" : "transparent",
                  }}
                />
              ))}
            </div>
          </div>
          <p className="-mt-1 font-mono text-[10px] leading-relaxed text-neutral-600">
            标签、边框与 HUD 线跟随主题；图表配色画在 canvas 里，读不到 CSS 变量，所以不变。
          </p>
          <div className="flex items-center justify-between gap-3">
            <Label>字号</Label>
            <div className="flex gap-2">
              <Chip active={settings.fontSize === "sm"} onClick={() => patch({ fontSize: "sm" })}>
                小
              </Chip>
              <Chip active={settings.fontSize === "md"} onClick={() => patch({ fontSize: "md" })}>
                中
              </Chip>
              <Chip active={settings.fontSize === "lg"} onClick={() => patch({ fontSize: "lg" })}>
                大
              </Chip>
            </div>
          </div>
          <div className="flex items-center justify-between gap-3">
            <Label>卡片密度</Label>
            <div className="flex gap-2">
              <Chip
                active={settings.density === "compact"}
                onClick={() => patch({ density: "compact" })}
              >
                紧凑
              </Chip>
              <Chip
                active={settings.density === "normal"}
                onClick={() => patch({ density: "normal" })}
              >
                标准
              </Chip>
            </div>
          </div>
          <Toggle
            on={settings.animation}
            onChange={(v) => patch({ animation: v })}
            label="界面动画与图表入场"
          />
          <Toggle
            on={settings.effects}
            onChange={(v) => patch({ effects: v })}
            label="背景网格与扫描线"
          />
          <p className="text-[11px] leading-relaxed text-neutral-600">
            字号改的是 rem 基准，所以间距会跟着等比缩放 —— 这正是 Tailwind 的工作方式。
            关掉动画后过渡被 CSS 直接掐断，图表入场时长归零。
          </p>
        </Group>

        <Group
          title="一键还原"
          hint="把本应用在这台浏览器上留下的东西全部清掉，回到刚装好的样子。"
        >
          <ul className="space-y-1 font-mono text-[11px] leading-relaxed text-neutral-500">
            <li>· 设置（密钥、外观）</li>
            <li>· 每个查询词各自记住的拖拽布局</li>
            <li>· 双语对照的本地缓存</li>
          </ul>
          <button
            type="button"
            onClick={() => (armed ? doReset() : setArmed(true))}
            className="w-full rounded-lg border px-4 py-2.5 font-mono text-[12px] transition-colors"
            style={{
              borderColor: armed ? "rgba(244,63,94,0.6)" : "rgba(255,255,255,0.12)",
              color: armed ? "rgb(251,113,133)" : "rgb(212,212,212)",
              background: armed ? "rgba(244,63,94,0.08)" : "transparent",
            }}
          >
            {armed ? "确定还原？再点一次（4 秒后取消）" : "一键还原默认"}
          </button>
          {isCustomized(settings) && (
            <p className="font-mono text-[10px] text-neutral-600">当前有自定义设置未还原。</p>
          )}
        </Group>

        <footer className="mt-auto border-t border-white/[0.07] px-6 py-4 font-mono text-[10px] leading-relaxed text-neutral-600">
          所有数据都在你的浏览器里。服务端不保存任何设置。
        </footer>
      </aside>
    </div>
  );
}