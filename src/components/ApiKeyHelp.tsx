"use client";

import type { ReactNode } from "react";

import {
  DEFAULT_MODEL_ID,
  PRESET_MODELS,
  PROVIDERS,
  type ProviderPreset,
} from "@/lib/model-presets";

/**
 * 「如何配置」—— 设置面板里 key 输入框下面的操作说明。
 *
 * 为什么单独一个文件：这段是给人看的步骤（去哪注册、点哪里、粘什么），跟组件逻辑无关；
 * 塞进 SettingsPanel 会把那个文件从「布局」变成「文档」。
 *
 * 预设表（各家接口地址 + 示例模型名）在 src/lib/model-presets.ts —— 那个文件同时喂给
 * runtime-config 的默认模型，两边不再各存一份靠注释对齐。
 */

/** 面板 placeholder 用的兜底模型名。与 runtime-config 同一个来源，不会再对不上。 */
export const DEFAULT_MODEL = DEFAULT_MODEL_ID;

export { DEFAULT_MODEL_ID, PRESET_MODELS, PROVIDERS };
export type { ProviderPreset };

function Code({ children }: { children: ReactNode }) {
  return (
    <span className="break-all rounded bg-neutral-900 px-1 py-0.5 font-mono text-[10px] text-neutral-300">
      {children}
    </span>
  );
}

function Link({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      className="break-all font-mono text-[10px] text-blue-400 underline decoration-blue-500/40 underline-offset-2 hover:text-blue-300"
    >
      {children}
    </a>
  );
}

function Step({ n, children }: { n: number; children: ReactNode }) {
  return (
    <li className="flex gap-2">
      <span className="mt-0.5 shrink-0 font-mono text-[10px] text-neutral-600">{n}.</span>
      <span className="text-[11px] leading-relaxed text-neutral-400">{children}</span>
    </li>
  );
}

/** 折叠壳：默认收起，点标题展开。样式对齐设置面板里的 Group。 */
export function HowTo({ title, children }: { title: string; children: ReactNode }) {
  return (
    <details className="group rounded-md border border-neutral-800 bg-[#0f0f0f]">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-2.5 py-1.5 font-mono text-[10px] text-neutral-400 marker:hidden hover:text-white">
        <span>{title}</span>
        <span aria-hidden className="shrink-0 text-neutral-600">
          <span className="group-open:hidden">展开</span>
          <span className="hidden group-open:inline">收起</span>
        </span>
      </summary>
      <div className="space-y-2.5 border-t border-neutral-800 px-2.5 py-2.5">{children}</div>
    </details>
  );
}

/** OpenAI key 这一栏的说明：去哪拿、怎么拿、以及「怎么用别家的模型」。 */
export function OpenAiKeyHelp() {
  return (
    <HowTo title="如何配置（其余模型也看这里）">
      <p className="text-[11px] leading-relaxed text-neutral-400">
        这一栏要的是 <span className="text-neutral-200">OpenAI 兼容</span> 服务的 key。
        官方只是其中一家：DeepSeek、Kimi、智谱 GLM、阿里百炼、硅基流动、OpenRouter、
        本地 Ollama 都能用 —— 前提是下面「接口地址」和「指定模型」按对应那行填对。
      </p>

      <ol className="space-y-1.5">
        <Step n={1}>打开下表的注册页，注册并登录（国内几家要实名，部分要先充一点点）。</Step>
        <Step n={2}>
          进控制台的 <span className="text-neutral-200">API Keys / 密钥</span> 页，
          点新建，把那一串复制走。
        </Step>
        <Step n={3}>
          key 通常<span className="text-neutral-200">只显示一次</span>；粘到上面，
          再点供应商标签（或手填接口地址与模型），立刻生效，不用重启。
        </Step>
      </ol>

      <div className="overflow-hidden rounded border border-neutral-800">
        <table className="w-full table-fixed border-collapse font-mono text-[10px]">
          <thead>
            <tr className="bg-[#141414] text-left text-neutral-500">
              <th className="w-[26%] px-2 py-1.5 font-normal">供应商</th>
              <th className="w-[74%] px-2 py-1.5 font-normal">拿 key 的地址 / 接口地址 / 模型</th>
            </tr>
          </thead>
          <tbody>
            {PROVIDERS.map((p) => (
              <tr key={p.id} className="border-t border-neutral-800 align-top">
                <td className="px-2 py-1.5 text-neutral-300">{p.name}</td>
                <td className="space-y-0.5 px-2 py-1.5">
                  <Link href={p.keyUrl}>{p.keyUrl.replace(/^https?:\/\//, "")}</Link>
                  <div className="text-neutral-500">
                    接口 <Code>{p.baseUrl || "https://api.openai.com/v1"}</Code>
                  </div>
                  <div className="text-neutral-500">
                    模型 <Code>{p.model}</Code>
                  </div>
                  <div className="text-neutral-600">{p.note}</div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="text-[11px] leading-relaxed text-neutral-500">
        填了不生效？大概率是格式：key 要 8–400 字符且不含空白，接口地址要带
        <Code>http://</Code> 或 <Code>https://</Code>，模型名不能带空格
        （<Code>gpt 6-luna</Code> 会被当成没填，写成 <Code>gpt-6-luna</Code>）。
        格式不对不会报错、只会静默回落到服务端配置 —— 所以「填了没生效」先回来核一遍格式；
        上游 401 / 404 则是 key 或接口地址本身不对，看服务端日志里那一条 status。
      </p>

      <p className="text-[11px] leading-relaxed text-neutral-500">
        本地 Ollama：请求是<span className="text-neutral-200">服务端</span>发出去的，
        所以要在跑这个服务的机器上 <Code>ollama serve</Code>；
        接口地址填 <Code>http://127.0.0.1:11434/v1</Code>，模型填
        <Code>ollama list</Code> 里有的名字，key 随便给 8 位（如{" "}
        <Code>ollama-local</Code>）。自己电脑上跑 Ollama、服务在云上，是连不上的。
      </p>
    </HowTo>
  );
}

/** Tavily key 这一栏的说明。 */
export function TavilyKeyHelp() {
  return (
    <HowTo title="如何配置">
      <ol className="space-y-1.5">
        <Step n={1}>
          打开 <Link href="https://app.tavily.com/home">app.tavily.com</Link>，
          用邮箱 / GitHub / Google 注册登录。
        </Step>
        <Step n={2}>
          登录后左侧栏就是 <span className="text-neutral-200">API Keys</span>，
          复制 <Code>tvly-</Code> 开头那一串（免费额度每月 1000 次，够试）。
        </Step>
        <Step n={3}>粘到上面即可。检索层立刻换成 Tavily，不用重启。</Step>
      </ol>
      <p className="text-[11px] leading-relaxed text-neutral-500">
        不填也能用：网页检索降级成免密钥的 <Code>HN</Code> 与 <Code>Wikipedia</Code>，
        核查里的「留出集外部核验」会整轮跳过 —— 是少一层证据，不是报错。
        额度用完同理，静默降级。
      </p>
      <p className="text-[11px] leading-relaxed text-neutral-500">
        复制时容易带上尾随空格，面板会自己 trim；如果提示 401，
        先去 Tavily 后台确认这把 key 还在、额度没用完。
      </p>
    </HowTo>
  );
}
