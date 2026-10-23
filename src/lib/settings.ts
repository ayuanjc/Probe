
import { CONFIG_HEADERS } from "@/lib/config-headers";

/**
 * 本机设置。全部落在 localStorage 的一个键里，服务端不存任何东西。
 *
 * 有一条边界必须写清（面板里也照实写）：API key 确实随请求头发给本服务，
 * 因为要用它去调 OpenAI / Tavily —— 但它只活在这一次请求的上下文里，
 * 不落盘、不写日志、不跨请求复用。别人的浏览器拿不到你的 key。
 */

export type Density = "compact" | "normal";
export type FontSize = "sm" | "md" | "lg";

export type Settings = {
  openaiKey: string;
  tavilyKey: string;
  model: string;
  density: Density;
  fontSize: FontSize;
  animation: boolean;
};

export const SETTINGS_KEY = "probe:settings:v1";
export const KEY_PREFIX = "probe:";

export const DEFAULT_SETTINGS: Settings = {
  openaiKey: "",
  tavilyKey: "",
  model: "",
  density: "normal",
  fontSize: "md",
  animation: true,
};

/** 卡片间距（px）：紧凑 16 / 标准 24。面板文案与网格读同一个常量，避免两处对不上。 */
export const GRID_GAP: Record<Density, number> = { compact: 16, normal: 24 };

function pick<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  return typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
}

function str(v: unknown, max: number): string {
  return typeof v === "string" ? v.slice(0, max) : "";
}

/** 读本机设置。任何字段坏掉都退回默认值，不让一条脏记录把整站打回白屏。 */
export function readSettings(): Settings {
  if (typeof window === "undefined") return { ...DEFAULT_SETTINGS };
  try {
    const raw = window.localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const o = JSON.parse(raw) as Partial<Settings>;
    return {
      openaiKey: str(o.openaiKey, 400),
      tavilyKey: str(o.tavilyKey, 400),
      model: str(o.model, 64),
      density: pick(o.density, ["compact", "normal"] as const, DEFAULT_SETTINGS.density),
      fontSize: pick(o.fontSize, ["sm", "md", "lg"] as const, DEFAULT_SETTINGS.fontSize),
      animation: typeof o.animation === "boolean" ? o.animation : DEFAULT_SETTINGS.animation,
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

/** 写入失败要如实返回 false（Safari 隐私模式、配额满都会失败）。 */
export function writeSettings(s: Settings): boolean {
  if (typeof window === "undefined") return false;
  try {
    window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
    return true;
  } catch {
    return false;
  }
}

/** 字号、密度、动效都通过 <html> 上的 data 属性 + 根字号驱动，不碰组件。 */
export function applySettings(s: Settings): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.dataset.density = s.density;
  root.dataset.anim = s.animation ? "on" : "off";
  // Tailwind 的间距/字号都是 rem，改根字号等于整站等比缩放。
  root.style.fontSize = s.fontSize === "sm" ? "15px" : s.fontSize === "lg" ? "17px" : "16px";
}

/** 只把非空值发出去：空串不该覆盖服务端 env 里已有的 key。 */
export function settingsHeaders(s: Settings): Record<string, string> {
  const h: Record<string, string> = {};
  const openai = s.openaiKey.trim();
  const tavily = s.tavilyKey.trim();
  const model = s.model.trim();
  if (openai) h[CONFIG_HEADERS.openaiKey] = openai;
  if (tavily) h[CONFIG_HEADERS.tavilyKey] = tavily;
  if (model) h[CONFIG_HEADERS.model] = model;
  return h;
}

export function isCustomized(s: Settings): boolean {
  return (Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[]).some(
    (k) => s[k] !== DEFAULT_SETTINGS[k],
  );
}

/**
 * 一键还原：只清本应用自己的键（probe: 前缀），不碰同域其他页面的数据。
 * 返回被删掉的键名，好让界面如实报出清了什么。
 */
export function resetLocalData(): string[] {
  if (typeof window === "undefined") return [];
  const removed: string[] = [];
  try {
    for (let i = window.localStorage.length - 1; i >= 0; i--) {
      const k = window.localStorage.key(i);
      if (k && k.startsWith(KEY_PREFIX)) {
        window.localStorage.removeItem(k);
        removed.push(k);
      }
    }
  } catch {
    return removed;
  }
  return removed;
}