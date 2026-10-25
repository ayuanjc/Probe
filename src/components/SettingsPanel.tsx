"use client";

import { useEffect, useRef, useState } from "react";
import { appPath } from "@/lib/base-path";
import type { ReactNode } from "react";
import { DEFAULT_SETTINGS, isCustomized, resetLocalData, settingsHeaders, type Settings } from "@/lib/settings";
import ConfigDocs from "./ConfigDocs";
import { OpenAiKeyHelp, TavilyKeyHelp } from "./ApiKeyHelp";
import { DEFAULT_MODEL_ID, PRESET_MODELS, PROVIDERS } from "@/lib/model-presets";
import { modelVendor, retrievalLabel } from "@/lib/service-labels";

function Group({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="border-t border-neutral-800 px-6 py-5">
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

/**
 * 「指定模型」输入框的候选项（只是下拉建议，不限制手填）。
 * 头两个取预设表里各家的示例模型，后面几个是常见的手填目标 —— 全都允许写不进去，
 * 因为校验在后端：模型名带空格或非法字符会被当成没填，面板也就回落默认。
 */
const MODEL_OPTIONS: string[] = Array.from(
  new Set([
    DEFAULT_MODEL_ID,
    ...PRESET_MODELS,
    /** 2026-10 当下的档位：贵的一档、便宜的一档各留几个，换服务商时不至于只会写老名字。 */
    "gpt-6.1-sol",
    "gpt-5.6-luna",
    "gpt-oss-120b",
    "deepseek-v4-pro",
    "kimi-k3.1-pro",
    "glm-5.3-flash",
    "qwen3.8-max",
    "qwen3.8-flash",
    "qwen3.8:latest",
  ]),
);

/**
 * /api/region 的返回：一次请求的**区域结论**，不是配置项。
 * 它随来访者变化，所以不进 Settings、不存本机 —— 每次打开面板现问一次。
 */
type RegionInfo = {
  region: "cn" | "intl";
  source: "mode" | "header" | "ip" | "default" | "unknown";
  country?: string;
  countryName?: string;
  ip?: string;
  ipScope: "public" | "private" | "unknown";
  modelHost: string;
  modelMode: "allowed" | "switched" | "blocked";
  retrieval: readonly string[];
};

/** 判定来源说人话：用户改不了这个结论，但有权知道它是怎么得出来的。 */
const REGION_SOURCE_TEXT: Record<RegionInfo["source"], string> = {
  mode: "部署时固定（PROBE_REGION_MODE）",
  header: "网关头里的国家码",
  ip: "来访 IP 反查",
  default: "兜底值（判不出来时按境内）",
  unknown: "未知",
};


const INPUT_CLASS =
  "w-full rounded-md border border-neutral-800 bg-[#0f0f0f] px-3 py-2 font-mono text-[12px] " +
  "text-white outline-none transition-colors " +
  "placeholder:text-neutral-600 focus:border-neutral-600";

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
        className="shrink-0 rounded-md border border-neutral-800 px-2.5 py-2 font-mono text-[10px] text-neutral-400 transition-colors hover:border-neutral-600 hover:text-white"
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
      aria-pressed={active}
      className={
        "rounded border px-3 py-1.5 font-mono text-[11px] transition-colors " +
        (active
          ? "border-neutral-600 bg-neutral-800 text-white"
          : "border-neutral-800 text-neutral-400 hover:border-neutral-600 hover:text-white")
      }
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
        style={{ background: on ? "var(--accent)" : "#3f3f46" }}
      >
        <span
          className="absolute top-0.5 h-3 w-3 rounded-full bg-black transition-all"
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
  /** 返回 false 表示只生效、没存进本机（配额满、隐私模式）。 */
  onChange: (next: Settings) => boolean;
  onClose: () => void;
}) {
  const [armed, setArmed] = useState(false);
  const [unsaved, setUnsaved] = useState(false);
  /**
   * 区域结论：null = 还没拉到，"error" = 拉失败。
   * 打开面板时才拉一次（区域取决于请求 IP，页面本身可能是缓存的），
   * 失败就闭嘴显示一句"读不到"，不编一个默认值糊过去。
   */
  const [region, setRegion] = useState<RegionInfo | null | "error">(null);
  const panelRef = useRef<HTMLElement | null>(null);
  /** 打开前焦点在哪：关掉之后要还回去，否则焦点掉到 body 上，键盘用户等于被扔在原地。 */
  const returnFocus = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) {
      setArmed(false);
      return;
    }
    returnFocus.current = document.activeElement as HTMLElement | null;

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
        return;
      }
      /**
       * 焦点陷阱：抽屉是 aria-modal，视觉上盖住了页面，但 Tab 仍然能走到
       * 背后的地图、卡片、按钮上 —— 对键盘用户来说"看不见却能操作"比不能用更糟。
       * 这里把焦点圈在抽屉里，首尾相接。
       */
      if (e.key !== "Tab" || !panelRef.current) return;
      const focusables = panelRef.current.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])',
      );
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey && (active === first || !panelRef.current.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKey);
    // 打开后先把焦点送进抽屉（用 rAF 等 DOM 挂上）。
    const raf = window.requestAnimationFrame(() => {
      const firstInput = panelRef.current?.querySelector<HTMLElement>("input, button");
      firstInput?.focus();
    });
    return () => {
      document.removeEventListener("keydown", onKey);
      window.cancelAnimationFrame(raf);
      const back = returnFocus.current;
      returnFocus.current = null;
      if (back && document.contains(back)) back.focus();
    };
  }, [open, onClose]);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setRegion(null);
    // 把面板里填的 key/端点一并带上：区域结论要按「这一轮真实会用的端点」算，
    // 否则填了境内端点的人会看到一句过时的「会被拦下」。
    fetch(appPath("/api/region"), {
      cache: "no-store",
      headers: settingsHeaders(settings),
    })
      .then((res) => (res.ok ? (res.json() as Promise<RegionInfo>) : null))
      .then((data) => {
        if (alive) setRegion(data ?? "error");
      })
      .catch(() => {
        if (alive) setRegion("error");
      });
    return () => {
      alive = false;
    };
    // 只跟这几个字段：改字号、改主题不该重新问一遍区域。
  }, [open, settings.openaiKey, settings.openaiBaseUrl, settings.model]);

  // 确认态会自己过期：晾在那里十分钟再点，等于没有二次确认。
  useEffect(() => {
    if (!armed) return;
    const t = window.setTimeout(() => setArmed(false), 4000);
    return () => window.clearTimeout(t);
  }, [armed]);

  if (!open) return null;

  function patch(p: Partial<Settings>) {
    const ok = onChange({ ...settings, ...p });
    setUnsaved(!ok);
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
        className="absolute inset-0 bg-black/70"
      />
      <aside
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="设置"
        className="scroll-thin safe-bottom relative flex h-full w-full max-w-[min(440px,100vw)] flex-col overflow-y-auto border-l border-neutral-800 bg-black"
      >
        <header className="sticky top-0 z-10 flex items-center justify-between gap-3 border-b border-neutral-800 bg-black px-6 py-4">
          <div>
            <h2 className="text-base font-semibold text-white">设置</h2>
            <p className="mt-0.5 font-mono text-[10px] text-neutral-600">
              改动即时生效 · 只存本机
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-neutral-800 px-2.5 py-1 font-mono text-[11px] text-neutral-400 transition-colors hover:border-neutral-600 hover:text-white"
          >
            ESC
          </button>
        </header>

        {unsaved && (
          <p
            role="status"
            className="mx-6 mt-4 rounded-md border border-yellow-500/30 bg-yellow-500/[0.06] px-3 py-2 text-[11px] leading-relaxed text-yellow-500/90"
          >
            设置没能写进本机存储（可能是隐私模式或配额已满）：现在生效，
            但刷新页面后会丢，这一轮的请求仍按刚才的配置走。
          </p>
        )}

        {/*
          区域结论放在 API 配置之前：它决定了下面那些 key「能不能用」。
          先讲清规则，再让人填 key，顺序反过来就会出现「填了却不生效」的困惑。
        */}
        <Group
          title="当前区域"
          hint="按来访 IP 与网关的国家头判定，每次请求现算；不读账号、不写 Cookie，也不参与个性化。它决定这一轮能用哪套模型与检索源。"
        >
          {region === null && (
            <p className="font-mono text-[11px] text-neutral-600">读取中…</p>
          )}
          {region === "error" && (
            <p className="text-[11px] leading-relaxed text-neutral-500">
              区域接口没读出来（不影响使用，只是这里显示不了结论）。
            </p>
          )}
          {region && region !== "error" && (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="rounded border border-neutral-800 bg-[#0f0f0f] px-2 py-0.5 font-mono text-[11px] text-white">
                  {region.region === "cn" ? "境内" : "境外"}
                </span>
                <span className="font-mono text-[10px] text-neutral-500">
                  {region.region} · {REGION_SOURCE_TEXT[region.source]}
                  {region.countryName
                    ? " · " + region.countryName + (region.country ? "（" + region.country + "）" : "")
                    : ""}
                </span>
                <span className="font-mono text-[10px] text-neutral-600">
                  IP {region.ipScope === "public" && region.ip
                    ? region.ip
                    : region.ipScope === "private"
                      ? "本机 / 内网"
                      : "未取到"}
                </span>
              </div>

              <div className="space-y-1">
                <Label>模型端点</Label>
                <p className="break-all font-mono text-[11px] text-neutral-300">
                  {modelVendor(region.modelHost)} · {region.modelHost}
                </p>
                <p className="text-[11px] leading-relaxed text-neutral-500">
                  {region.modelMode === "allowed"
                    ? "该端点在当前区域允许直接调用。"
                    : region.modelMode === "switched"
                      ? "原端点不属于本区域，已按配置换成上面的境内端点。"
                      : "该端点不属于本区域，且没有配置境内替代端点 —— 这一轮不会调用任何模型（面板与摘要退回本地模板），而不是偷偷发出去。"}
                </p>
              </div>

              <div className="space-y-1">
                <Label>可用检索源</Label>
                <p className="text-[11px] leading-relaxed text-neutral-300">
                  {region.retrieval.length === 0
                    ? "无"
                    : region.retrieval.map(retrievalLabel).join(" · ")}
                </p>
                <p className="text-[11px] leading-relaxed text-neutral-500">
                  不在列表里的源不会发起请求，界面上会标「当前区域不使用」。
                </p>
              </div>

              {settings.openaiKey.trim() !== "" && region.modelMode === "blocked" && (
                <p className="rounded-md border border-yellow-500/30 bg-yellow-500/[0.06] px-3 py-2 text-[11px] leading-relaxed text-yellow-500/90">
                  你填的 key 属于境外端点，在境内会被区域规则拦下 —— 它不会被发出去。
                  想让境内的搜索也有模型结果，需要在服务端配置境内端点（PROBE_CN_MODEL_KEY）。
                </p>
              )}
            </div>
          )}
        </Group>

        <Group
          title="API 配置"
          hint="填了就用你的：服务端不再看自己的 env。留空则沿用服务端配置。接受任何 OpenAI 兼容的服务，不限于官方。"
        >
          <div className="space-y-1.5">
            <Label>OpenAI key</Label>
            <Secret
              value={settings.openaiKey}
              onChange={(v) => patch({ openaiKey: v })}
              placeholder="sk-…（意图精修 / 断言抽取 / 摘要 / 翻译；别家的 key 也放这一栏）"
            />
            <OpenAiKeyHelp />
          </div>

          <div className="space-y-1.5">
            <Label>接口地址 Base URL</Label>
            <input
              type="text"
              value={settings.openaiBaseUrl}
              onChange={(e) => patch({ openaiBaseUrl: e.target.value })}
              placeholder="留空 = https://api.openai.com/v1"
              spellCheck={false}
              autoComplete="off"
              inputMode="url"
              className={INPUT_CLASS}
            />
            <div className="flex flex-wrap gap-1.5">
              {PROVIDERS.map((p) => {
                const active = (settings.openaiBaseUrl.trim() || "") === p.baseUrl;
                return (
                  <button
                    key={p.id}
                    type="button"
                    title={p.note}
                    onClick={() => patch({ openaiBaseUrl: p.baseUrl, model: p.model })}
                    className={
                      "rounded-md border px-2 py-1 font-mono text-[10px] transition-colors " +
                      (active
                        ? "border-blue-500/50 bg-blue-500/10 text-blue-300"
                        : "border-neutral-800 text-neutral-400 hover:border-neutral-600 hover:text-white")
                    }
                  >
                    {p.name}
                  </button>
                );
              })}
            </div>
            <p className="font-mono text-[10px] leading-relaxed text-neutral-600">
              点标签 = 一次填好地址与模型；也可以自己写任何兼容网关。
            </p>
          </div>

          <div className="space-y-1.5">
            <Label>指定模型</Label>
            <input
              type="text"
              list="probe-model-options"
              value={settings.model}
              onChange={(e) => patch({ model: e.target.value })}
              placeholder={DEFAULT_MODEL_ID}
              spellCheck={false}
              autoComplete="off"
              className={INPUT_CLASS}
            />
            <datalist id="probe-model-options">
              {MODEL_OPTIONS.map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
            <p className="font-mono text-[10px] leading-relaxed text-neutral-600">
              {settings.model.trim()
                ? "这一轮指定：" + settings.model.trim()
                : "留空 = " + DEFAULT_MODEL_ID + "（或服务端 PROBE_MODEL）"}
            </p>
          </div>

          <div className="space-y-1.5">
            <Label>Tavily key</Label>
            <Secret
              value={settings.tavilyKey}
              onChange={(v) => patch({ tavilyKey: v })}
              placeholder="tvly-…（网页检索；没填就只走免密钥的 HN / Wikipedia）"
            />
            <TavilyKeyHelp />
          </div>

          <p className="rounded border border-neutral-800 bg-[#141414] px-3 py-2.5 text-[11px] leading-relaxed text-neutral-400">
            key 存在这台浏览器的 localStorage 里，每次检索 / 翻译时随请求头发给本服务，
            服务端只在这一轮请求里用它调上游 —— 不写数据库、不写日志、不跨请求复用。
            接口地址与模型走同一条通道（x-probe-openai-base-url / x-probe-model）。
            换台设备或清站点数据就没了。
          </p>
        </Group>

        <Group title="界面" hint="改的是 html 上的 data 属性与根字号，不碰任何组件。">
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
          <p className="text-[11px] leading-relaxed text-neutral-600">
            字号改的是 rem 基准，所以间距会跟着等比缩放 —— 这正是 Tailwind 的工作方式。
            关掉动画后过渡被 CSS 直接掐断，图表入场时长归零。
          </p>
        </Group>

        <Group
          title="配置文档"
          hint="每一项到底写在哪、发到哪、优先级如何 —— 抄的是代码，不是设想。"
        >
          <ConfigDocs />
        </Group>

        <Group
          title="一键还原"
          hint="把本应用在这台浏览器上留下的东西全部清掉，回到刚装好的样子。"
        >
          <ul className="space-y-1 font-mono text-[11px] leading-relaxed text-neutral-500">
            <li>· 设置（密钥、界面）</li>
            <li>· 每个查询词各自记住的拖拽布局</li>
            <li>· 双语对照的本地缓存</li>
          </ul>
          <button
            type="button"
            onClick={() => (armed ? doReset() : setArmed(true))}
            className={
              "w-full rounded-md border px-4 py-2.5 font-mono text-[12px] transition-colors " +
              (armed
                ? "border-red-500/60 bg-red-500/10 text-red-400"
                : "border-neutral-800 text-neutral-300 hover:border-neutral-600 hover:text-white")
            }
          >
            {armed ? "确定还原？再点一次（4 秒后取消）" : "一键还原默认"}
          </button>
          {isCustomized(settings) && (
            <p className="font-mono text-[10px] text-neutral-600">当前有自定义设置未还原。</p>
          )}
        </Group>

        <footer className="mt-auto border-t border-neutral-800 px-6 py-4 font-mono text-[10px] leading-relaxed text-neutral-600">
          所有数据都在你的浏览器里。服务端不保存任何设置。
        </footer>
      </aside>
    </div>
  );
}
