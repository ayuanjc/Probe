"use client";

import { useState } from "react";
import type { ReactNode } from "react";
import { LAYOUT_VERSION } from "@/lib/layout";
import { KEY_PREFIX, SETTINGS_KEY } from "@/lib/settings";

/**
 * 配置文档（设置面板里的「配置文档」一节）。
 *
 * 存在的理由：这个项目的配置分散在三层 —— 浏览器里的设置、请求头、服务端 env。
 * 「为什么我填了 key 还是走本地模板」「为什么 cron 端点 503」这类问题，
 * 答案都能在代码里查到，但没人愿意为了查一行去翻六个文件。所以把它们并排放这里，
 * 并且只抄代码里真有的东西：.env.example 里写了而代码没读的变量也照实标出来，
 * 否则配了不生效比没写更伤人。
 */

const CONFIG_ROWS: { label: string; store: string; header: string; env: string; fallback: string }[] = [
  {
    label: "OpenAI key",
    store: "设置 → openaiKey",
    header: "x-probe-openai-key",
    env: "OPENAI_API_KEY",
    fallback: "都没有：摘要走本地模板，断言抽取关闭",
  },
  {
    label: "接口地址",
    store: "设置 → openaiBaseUrl",
    header: "x-probe-openai-base-url",
    env: "OPENAI_BASE_URL",
    fallback: "都没有：https://api.openai.com/v1",
  },
  {
    label: "Tavily key",
    store: "设置 → tavilyKey",
    header: "x-probe-tavily-key",
    env: "TAVILY_API_KEY",
    fallback: "都没有：只走免密钥的 HN / Wikipedia",
  },
  {
    label: "指定模型",
    store: "设置 → model",
    header: "x-probe-model",
    env: "PROBE_MODEL",
    fallback: "都没有：gpt-6-luna",
  },
];

const ENV_ROWS: [string, string, string][] = [
  ["OPENAI_API_KEY", "意图精修 / 断言抽取 / 摘要 / 段落翻译", "空"],
  ["OPENAI_BASE_URL", "OpenAI 兼容接口地址（网关 / DeepSeek / 本地 Ollama）", "空 = 官方"],
  ["TAVILY_API_KEY", "网页检索（Tavily 搜索层）", "空"],
  ["PROBE_MODEL", "模型 id", "gpt-6-luna"],
  ["PROBE_RATE_LIMIT_PER_MIN", "/api/search 每 IP 每分钟检索次数", "3"],
  ["PROBE_TRANSLATE_RATE_LIMIT_PER_MIN", "/api/translate 每 IP 每分钟", "20"],
  ["PROBE_MODULE_RATE_LIMIT_PER_MIN", "/api/module 每 IP 每分钟", "12"],
  ["PROBE_FEEDBACK_RATE_LIMIT_PER_MIN", "/api/feedback 每 IP 每分钟", "5"],
  ["PROBE_METRICS_KEY", "配了才能看到 /api/metrics 里的查询词", "未配 → 查询词脱敏"],
  ["PROBE_CRON_SECRET", "打开 /api/cron/heat 的口令", "未配 → 端点直接 503"],
];

const STORAGE_ROWS: [string, string][] = [
  [SETTINGS_KEY, "设置：keys、模型、字号、密度、动画"],
  [KEY_PREFIX + "layout:" + LAYOUT_VERSION + ":<查询词>", "每个查询词各自的拖拽布局快照"],
  ["probe:grid-hint:v1", "网格操作提示是否已被收起"],
];

const ROUTES: [string, string, string][] = [
  ["POST /api/search", "检索 + 面板流水线（SSE）", "按 IP 限流"],
  ["POST /api/translate", "对照翻译（抓正文 + 逐段译）", "按 IP 限流"],
  ["POST /api/module", "一句话生成面板", "按 IP 限流"],
  ["POST /api/feedback", "页脚反馈（追加到 .cache/feedback.jsonl）", "按 IP 限流"],
  ["GET /api/metrics", "运行指标（内存，环形 200 条）", "默认脱敏查询词"],
  ["GET /api/cron/heat", "后台热度计算（30 天基线）", "需口令，未配即关"],
];

const ENV_SAMPLE = [
  "# .env.local（仓库根目录，改完要重启 dev / start）",
  "OPENAI_API_KEY=sk-…",
  "# 走别家 / 自建网关时才需要（含 /v1，例如 DeepSeek 是 https://api.deepseek.com/v1）",
  "# OPENAI_BASE_URL=https://api.deepseek.com/v1",
  "TAVILY_API_KEY=tvly-…",
  "PROBE_MODEL=gpt-6-luna",
  "",
  "# 限流：默认值很紧，本地压测时调高",
  "PROBE_RATE_LIMIT_PER_MIN=3",
  "PROBE_TRANSLATE_RATE_LIMIT_PER_MIN=20",
  "PROBE_MODULE_RATE_LIMIT_PER_MIN=12",
  "PROBE_FEEDBACK_RATE_LIMIT_PER_MIN=5",
  "",
  "# 只在要看查询词时设（请求带 x-probe-metrics-key 头）",
  "PROBE_METRICS_KEY=…",
  "# 配了才会打开 /api/cron/heat（否则 503）",
  "PROBE_CRON_SECRET=…",
].join("\n");

function Section({
  title,
  hint,
  defaultOpen,
  children,
}: {
  title: string;
  hint?: string;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  return (
    <details
      open={defaultOpen}
      className="group rounded-md border border-neutral-800 bg-[#0f0f0f]"
    >
      <summary className="flex cursor-pointer list-none items-baseline justify-between gap-2 px-3 py-2 text-[12px] text-neutral-300 marker:hidden hover:text-white">
        <span>{title}</span>
        <span aria-hidden className="shrink-0 font-mono text-[10px] text-neutral-600">
          <span className="group-open:hidden">展开</span>
          <span className="hidden group-open:inline">收起</span>
        </span>
      </summary>
      <div className="border-t border-neutral-800 px-3 py-3">
        {hint && (
          <p className="mb-2.5 text-[11px] leading-relaxed text-neutral-500">{hint}</p>
        )}
        {children}
      </div>
    </details>
  );
}

function EnvName({ children }: { children: ReactNode }) {
  return <span className="break-all font-mono text-[10px] text-neutral-300">{children}</span>;
}

export default function ConfigDocs() {
  const [copied, setCopied] = useState<"idle" | "ok" | "fail">("idle");

  async function copyEnv() {
    try {
      await navigator.clipboard.writeText(ENV_SAMPLE);
      setCopied("ok");
    } catch {
      // 非 https / 未授权时 clipboard 会抛：如实说复制失败，别让按钮装作成功。
      setCopied("fail");
    }
    window.setTimeout(() => setCopied("idle"), 1800);
  }

  return (
    <div className="space-y-2" data-config-docs>
      <Section
        title="三层配置：本机设置 → 请求头 → 服务端 env"
        defaultOpen
        hint="优先级从上到下。填了面板里的 key，这一轮就完全不看服务端 env —— 不会两把 key 混用。"
      >
        <div className="space-y-2">
          {CONFIG_ROWS.map((r) => (
            <div key={r.label} className="rounded border border-neutral-800 px-2.5 py-2">
              <p className="text-[12px] text-neutral-200">{r.label}</p>
              <dl className="mt-1.5 grid grid-cols-[28px_1fr] gap-x-2 gap-y-1 font-mono text-[10px] leading-relaxed">
                <dt className="text-neutral-600">存</dt>
                <dd className="break-all text-neutral-400">{r.store}</dd>
                <dt className="text-neutral-600">头</dt>
                <dd className="break-all text-neutral-400">{r.header}</dd>
                <dt className="text-neutral-600">env</dt>
                <dd className="break-all text-neutral-400">{r.env}</dd>
                <dt className="text-neutral-600">无</dt>
                <dd className="break-all text-neutral-500">{r.fallback}</dd>
              </dl>
            </div>
          ))}
        </div>
        <p className="mt-2.5 text-[11px] leading-relaxed text-neutral-500">
          脏值一律当没填：key 要 8–400 字符且不含空白，模型要匹配 {" "}
          <span className="font-mono text-[10px] text-neutral-400">
            [A-Za-z0-9._:-]{"{"}2,64{"}"}
          </span>
          。填错不会报错，只会静默回落到服务端配置 —— 所以「填了没生效」先回来对一遍格式。
        </p>
      </Section>

      <Section
        title="服务端环境变量"
        hint="写在仓库根的 .env.local，改完要重启进程才生效（Next 只在启动时读一次）。"
      >
        <div className="space-y-1.5">
          {ENV_ROWS.map(([name, use, def]) => (
            <div key={name} className="flex flex-col gap-0.5 border-b border-neutral-800/70 pb-1.5 last:border-b-0 last:pb-0">
              <EnvName>{name}</EnvName>
              <span className="text-[11px] leading-snug text-neutral-500">
                {use}
                <span className="text-neutral-700"> · 默认 {def}</span>
              </span>
            </div>
          ))}
        </div>
        <div className="mt-3 rounded border border-neutral-800">
          <div className="flex items-center justify-between gap-2 border-b border-neutral-800 px-2.5 py-1.5">
            <span className="font-mono text-[10px] text-neutral-600">.env.local</span>
            <button
              type="button"
              onClick={copyEnv}
              aria-label="复制环境变量示例"
              className="rounded border border-neutral-800 px-2 py-0.5 font-mono text-[10px] text-neutral-400 transition-colors hover:border-neutral-600 hover:text-white"
            >
              {copied === "ok" ? "已复制" : copied === "fail" ? "复制失败" : "复制"}
            </button>
          </div>
          <pre className="scroll-thin overflow-x-auto px-2.5 py-2 font-mono text-[10px] leading-relaxed text-neutral-400">
            {ENV_SAMPLE}
          </pre>
        </div>
        <p className="mt-2.5 text-[11px] leading-relaxed text-neutral-500">
          .env.example 里还有 <span className="font-mono text-[10px] text-neutral-400">PROBE_DAILY_TOKEN_BUDGET</span>、
          <span className="font-mono text-[10px] text-neutral-400">PROBE_CACHE_TTL_SECONDS</span>
          —— 代码目前没有读取它们，写了不会生效。留在这里是为了不让示例和实现各说各话。
          （<span className="font-mono text-[10px] text-neutral-400">OPENAI_BASE_URL</span> 已经从这份名单里摘掉了：
          它现在是真读的，见上表「接口地址」。）
        </p>
      </Section>

      <Section title="本机存储键" hint="全在这台浏览器的 localStorage 里；一键还原会按 probe: 前缀全清。">
        <dl className="space-y-1.5">
          {STORAGE_ROWS.map(([k, v]) => (
            <div key={k} className="flex flex-col gap-0.5">
              <EnvName>{k}</EnvName>
              <span className="text-[11px] leading-snug text-neutral-500">{v}</span>
            </div>
          ))}
        </dl>
        <p className="mt-2.5 text-[11px] leading-relaxed text-neutral-500">
          布局快照的键里带版本号（当前 {" "}
          <span className="font-mono text-[10px] text-neutral-400">{LAYOUT_VERSION}</span>
          ）：网格行高或间距一改，旧坐标就不再对应，版本不符整份丢弃而不是硬套。
        </p>
      </Section>

      <Section title="接口与鉴权" hint="每个路由的限流与口令，都是代码里的实际默认值。">
        <div className="space-y-1.5">
          {ROUTES.map(([route, what, gate]) => (
            <div key={route} className="flex flex-col gap-0.5 border-b border-neutral-800/70 pb-1.5 last:border-b-0 last:pb-0">
              <EnvName>{route}</EnvName>
              <span className="text-[11px] leading-snug text-neutral-500">{what}</span>
              <span className="font-mono text-[10px] text-neutral-600">{gate}</span>
            </div>
          ))}
        </div>
        <p className="mt-2.5 text-[11px] leading-relaxed text-neutral-500">
          Cron 端的口令走 {" "}
          <span className="font-mono text-[10px] text-neutral-400">Authorization: Bearer &lt;secret&gt;</span>
          {" "} 或 {" "}
          <span className="font-mono text-[10px] text-neutral-400">x-probe-cron-secret</span>
          ；指标端走 {" "}
          <span className="font-mono text-[10px] text-neutral-400">x-probe-metrics-key</span>。
        </p>
      </Section>
    </div>
  );
}
