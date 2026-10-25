"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { appPath } from "@/lib/base-path";
import type { TranslateResponse, TranslateResult } from "@/lib/translate-types";
import type { RiskBand } from "@/lib/translate-risk";

const BAND_LABEL: Record<RiskBand, string> = { low: "低", mid: "中", high: "高" };

/** 三档沿用全站语义色：低=蓝（对得上），中=黄（要核对），高=红（可能被改写）。 */
const BAND_BOX: Record<RiskBand, string> = {
  low: "border-blue-500/40 bg-blue-500/[0.05]",
  mid: "border-yellow-500/45 bg-yellow-500/[0.05]",
  high: "border-red-500/45 bg-red-500/[0.05]",
};

const BAND_TEXT: Record<RiskBand, string> = {
  low: "text-blue-400",
  mid: "text-yellow-500",
  high: "text-red-400",
};

const DOC_SOURCE_TEXT: Record<string, string> = {
  fetched: "已抓到正文",
  provided: "调用方提供的正文",
  snippet: "只有标题与片段",
};

const DEGRADE_TEXT: Record<string, string> = {
  "fetch:timeout": "正文抓取超时（对方站点太慢）",
  "fetch:http_403": "对方站点拒绝抓取（403）",
  "fetch:http_404": "原文链接已失效（404）",
  "fetch:http_429": "对方站点限流（429）",
  "fetch:url_blocked": "内网地址不抓取",
  "fetch:too_short": "正文太短，退回标题对照",
  "fetch:not_html": "不是网页正文，退回标题对照",
  "fetch:fetch_failed": "正文抓取失败",
  "doc:title_only": "只对照了标题与片段，不是全文",
  "segments:capped": "段落过多，只对照了前 48 段",
  "engine:unavailable": "翻译引擎不可用",
  "engine:langpair_unsupported": "该语言对没有可用引擎",
};

function degradeText(code: string): string {
  if (DEGRADE_TEXT[code]) return DEGRADE_TEXT[code];
  const partial = /^engine:partial_(\d+)of(\d+)$/.exec(code);
  if (partial) {
    return (
      "公共接口有每日配额：这次 " + partial[2] + " 段里翻成 " +
      (Number(partial[2]) - Number(partial[1])) + " 段，其余保留原文"
    );
  }
  return code;
}

// 同一条信源反复展开不该反复打接口：翻译是要花钱和配额的操作。
// 只缓存成功结果 —— 429 / 超时 / 5xx 是"这一刻不行"，缓存下来会让重试永远命中失败。
const cache = new Map<string, TranslateResponse>();
const CACHE_MAX = 24;

function cachePut(key: string, data: TranslateResponse): void {
  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, data);
}

export default function BilingualCompare({
  url,
  title,
  text,
}: {
  url: string;
  title: string;
  text?: string;
}) {
  /*
   * key 必须含 text：同一条信源在不同出处常带不同片段（SourceList 传的是 s.quote），
   * 只按 url+title 记缓存会让后一个片段直接命中前一段的译文 —— 译的是别的话。
   */
  const key = url + "\u0000" + title + "\u0000" + (text ?? "");
  const [state, setState] = useState<{ status: "loading" | "ready" | "error"; data?: TranslateResponse }>(
    () => {
      const hit = cache.get(key);
      return hit ? { status: "ready", data: hit } : { status: "loading" };
    },
  );

  /** 收起卡片或切到别的信源时中止在途请求：别为看不见的面板烧翻译配额，也别往卸载的组件里写。 */
  const acRef = useRef<AbortController | null>(null);

  const load = useCallback(
    async (force = false) => {
      if (!force) {
        const hit = cache.get(key);
        if (hit) {
          setState({ status: "ready", data: hit });
          return;
        }
      }
      acRef.current?.abort();
      const ac = new AbortController();
      acRef.current = ac;
      setState({ status: "loading" });
      try {
        const res = await fetch(appPath("/api/translate"), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ url, title, text }),
          signal: ac.signal,
        });
        // 429/422 也会返回 JSON，但那是"这次没成"。先按 HTTP 判失败，别把它当结果缓存。
        if (!res.ok) throw new Error("HTTP " + res.status);
        const data = (await res.json()) as TranslateResponse;
        if (ac.signal.aborted) return;
        if (data && data.ok) cachePut(key, data);
        setState({ status: "ready", data });
      } catch {
        if (ac.signal.aborted) return;
        setState({ status: "error" });
      }
    },
    [key, url, title, text],
  );

  /**
   * 自动加载只发一次。以前依赖 state.status === "loading" 触发，重试把状态设回 loading
   * 又会让 effect 再发一次 —— 一次点击两条请求，后到的（往往是限流降级的那条）覆盖先进的。
   * 现在 effect 只管"首次进入这个 key"，按钮走 load(true) 这一条独立路径。
   */
  const started = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (started.current.has(key)) return;
    started.current.add(key);
    void load();
    // 卸载时把这把锁放掉：React 严格模式下 effect 会「挂载 → 卸载 → 再挂载」，
    // 第一次的请求被 cleanup 中止，锁若不解除，第二次挂载就什么都不做，
    // 面板永远停在「正在抓正文并分段翻译…」。生产环境不复现，开发环境天天见。
    return () => {
      started.current.delete(key);
    };
  }, [key, load]);

  useEffect(() => () => acRef.current?.abort(), []);

  if (state.status === "loading") {
    return (
      <div className="mt-3 rounded-md border border-neutral-800 bg-[#0f0f0f] px-4 py-3 font-mono text-[10px] text-neutral-500">
        <span className="mr-2 inline-block h-1 w-1 animate-pulse bg-blue-500" />
        正在抓正文并分段翻译…
      </div>
    );
  }

  if (state.status === "error" || !state.data) {
    return (
      <div className="mt-3 flex items-center gap-3 rounded-md border border-red-500/30 bg-red-500/[0.06] px-4 py-3 text-[11px] text-red-400">
        对照失败（网络或接口异常）。
        <button
          type="button"
          onClick={() => void load(true)}
          className="rounded border border-red-500/40 px-2 py-0.5 font-mono text-[10px] hover:border-red-400"
        >
          重试
        </button>
      </div>
    );
  }

  const data = state.data;
  if (!data.ok) {
    return (
      <div className="mt-3 flex flex-wrap items-center gap-3 rounded-md border border-yellow-500/25 bg-yellow-500/[0.05] px-4 py-3 text-[11px] text-yellow-500/90">
        <span className="min-w-0 flex-1">{data.message}</span>
        {/* 限流与临时抓取失败都落在这个分支：不给重试按钮，用户只能关掉再开。 */}
        <button
          type="button"
          onClick={() => void load(true)}
          className="shrink-0 rounded border border-yellow-500/40 px-2 py-0.5 font-mono text-[10px] hover:border-yellow-400"
        >
          重试
        </button>
      </div>
    );
  }

  return <CompareBody data={data} onRetry={() => void load(true)} />;
}

function CompareBody({ data, onRetry }: { data: TranslateResult; onRetry: () => void }) {
  // 没有译文时逐段标色只会骗人：绿色看起来像"质检通过"，其实什么都没翻。
  // 两种"没有译文"要分开：引擎挂了（要报警）vs 原文本来就是中文（无需翻译）。
  const noEngine = data.engine === "none" && data.needsTranslation;
  /** 语言没认出来：既不是"引擎挂了"，也不是"本来就是中文"，要单独说。 */
  const unknownLang = data.degraded.includes("lang:unknown");
  const singleColumn = noEngine || !data.needsTranslation;
  return (
    <div
      className="mt-3 rounded-md border border-neutral-800 bg-[#0f0f0f] p-4"
      data-testid="compare"
      data-engine={data.engine}
      data-band={data.overall.band}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 font-mono text-[10px] text-neutral-500">
        <span className="rounded border border-neutral-700 px-2 py-0.5 text-neutral-300">
          {data.fromName} → {data.toName}
        </span>
        <span>{DOC_SOURCE_TEXT[data.docSource] ?? data.docSource}</span>
        <span className="tabular-nums">{data.chars} 字</span>
        <span className="tabular-nums">{data.segments.length} 段</span>
        {!singleColumn && (
          <span
            className={
              "rounded border px-2 py-0.5 " +
              (data.overall.band === "low"
                ? "border-blue-500/30 text-blue-400"
                : data.overall.band === "mid"
                  ? "border-yellow-500/30 text-yellow-500"
                  : "border-red-500/30 text-red-400")
            }
          >
            平均歧义 {data.overall.risk.toFixed(2)} · {BAND_LABEL[data.overall.band]}
          </span>
        )}
        <span className="text-neutral-600">{data.engineNote}</span>
        {data.url && (
          <a
            href={data.url}
            target="_blank"
            rel="noreferrer noopener"
            className="ml-auto text-neutral-400 underline decoration-dotted hover:text-white"
          >
            打开原页面 ↗
          </a>
        )}
      </div>

      {noEngine && (
        <p className="mt-3 rounded border border-neutral-800 bg-[#141414] px-3 py-2 text-[11px] leading-relaxed text-neutral-400">
          没有可用的翻译引擎（未配置模型，公共接口也不通），下面是分段后的原文，译文与歧义配色都没有生成。
        </p>
      )}

      {!data.needsTranslation && !unknownLang && (
        <p className="mt-3 text-[11px] leading-relaxed text-neutral-500">
          原文本来就是中文：只做分段，不产生翻译，也就没有可标的歧义。
        </p>
      )}

      {unknownLang && (
        <p className="mt-3 text-[11px] leading-relaxed text-neutral-500">
          没认出原文语言（很短的标题或中英混排会这样）：只做分段，不翻译、不上色 ——
          认不出语言就判断"译得准不准"是没有依据的。
        </p>
      )}

      {/* 颜色图例必须自带解释：否则用户会把玫红当成"翻错了"，或把青色当成"审核通过"。 */}
      {!singleColumn && (
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[10px] text-neutral-500">
          <span className="text-neutral-400">颜色 = 该段译文的可核对差异，不是质量评分：</span>
          <span className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-sm border-l-2 border-blue-500/60 bg-blue-500/20" />
            低（数字/专名都对得上）
          </span>
          <span className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-sm border-l-2 border-yellow-500/70 bg-yellow-500/25" />
            中（有需要核对的差异）
          </span>
          <span className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-sm border-l-2 border-red-500/70 bg-red-500/25" />
            高（信息可能被改写或漏掉）
          </span>
        </div>
      )}

      {data.degraded.length > 0 && (
        <div className="mt-3 rounded border border-yellow-500/20 bg-yellow-500/[0.05] px-3 py-2 text-[10px] leading-relaxed text-yellow-500/90">
          降级：{data.degraded.map(degradeText).join(" · ")}
        </div>
      )}

      {singleColumn ? (
        <ol className="mt-3 space-y-2">
          {data.segments.map((seg) => (
            // data-seg 是给测试与无障碍用的稳定钩子：没有它就只能靠行号数段落，
            // 而"有没有分段"和"有没有译文"是两件事，不能共用一个属性。
            <li key={seg.i} data-seg={seg.i}>
              <p className="text-[11px] leading-relaxed text-neutral-400">
                <span className="mr-2 font-mono text-[9px] tabular-nums text-neutral-700">
                  {String(seg.i + 1).padStart(2, "0")}
                </span>
                {seg.src}
              </p>
            </li>
          ))}
        </ol>
      ) : (
      <ol className="mt-3 space-y-2">
        {data.segments.map((seg) => (
          <li key={seg.i} data-seg={seg.i} className="grid gap-2 md:grid-cols-2">
            <p className="text-[11px] leading-relaxed text-neutral-500">
              <span className="mr-2 font-mono text-[9px] tabular-nums text-neutral-700">
                {String(seg.i + 1).padStart(2, "0")}
              </span>
              {seg.src}
            </p>
            <div data-band={seg.band} className={"rounded border-l-2 px-3 py-1.5 " + BAND_BOX[seg.band]}>
              <p className="text-[11px] leading-relaxed text-neutral-200">
                {seg.dst || <span className="text-neutral-600">（未翻成，保留原文）</span>}
              </p>
              {seg.signals.some((s) => s.weight > 0) && (
                <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                  <span className={"font-mono text-[9px] tabular-nums " + BAND_TEXT[seg.band]}>
                    歧义 {seg.risk.toFixed(2)}
                  </span>
                  {seg.signals
                    .filter((s) => s.weight > 0)
                    .map((s) => (
                      <span
                        key={s.code}
                        title={s.detail ?? s.label}
                        className="rounded border border-neutral-800 px-1.5 py-0.5 text-[9px] text-neutral-400"
                      >
                        {s.label}
                        {s.detail ? "：" + s.detail : ""}
                      </span>
                    ))}
                </div>
              )}
            </div>
          </li>
        ))}
      </ol>
      )}

      {data.truncated && (
        <p className="mt-3 font-mono text-[10px] text-neutral-600">
          正文过长，只对照了前 {data.chars} 字。
        </p>
      )}

      <button
        type="button"
        onClick={onRetry}
        className="mt-3 font-mono text-[10px] text-neutral-600 underline decoration-dotted hover:text-neutral-400"
      >
        重新抓取并翻译
      </button>
    </div>
  );
}
