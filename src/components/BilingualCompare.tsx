"use client";

import { useCallback, useEffect, useState } from "react";
import type { TranslateResponse, TranslateResult } from "@/lib/translate-types";
import type { RiskBand } from "@/lib/translate-risk";

const BAND_LABEL: Record<RiskBand, string> = { low: "低", mid: "中", high: "高" };

const BAND_BOX: Record<RiskBand, string> = {
  low: "border-cyan-500/40 bg-cyan-500/[0.04]",
  mid: "border-amber-400/55 bg-amber-400/[0.06]",
  high: "border-rose-500/60 bg-rose-500/[0.07]",
};

const BAND_TEXT: Record<RiskBand, string> = {
  low: "text-cyan-300",
  mid: "text-amber-300",
  high: "text-rose-300",
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
const cache = new Map<string, TranslateResponse>();

export default function BilingualCompare({
  url,
  title,
  text,
}: {
  url: string;
  title: string;
  text?: string;
}) {
  const key = url + "\u0000" + title;
  const [state, setState] = useState<{ status: "loading" | "ready" | "error"; data?: TranslateResponse }>(
    () => {
      const hit = cache.get(key);
      return hit ? { status: "ready", data: hit } : { status: "loading" };
    },
  );

  const load = useCallback(
    async (force = false) => {
      if (!force) {
        const hit = cache.get(key);
        if (hit) {
          setState({ status: "ready", data: hit });
          return;
        }
      }
      setState({ status: "loading" });
      try {
        const res = await fetch("/api/translate", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ url, title, text }),
        });
        const data = (await res.json()) as TranslateResponse;
        cache.set(key, data);
        setState({ status: "ready", data });
      } catch {
        setState({ status: "error" });
      }
    },
    [key, url, title, text],
  );

  useEffect(() => {
    if (state.status === "loading") void load();
  }, [state.status, load]);

  if (state.status === "loading") {
    return (
      <div className="mt-3 rounded-lg border border-white/10 bg-black/30 px-4 py-3 font-mono text-[10px] text-neutral-500">
        <span className="mr-2 inline-block h-1 w-1 animate-pulse rounded-sm bg-cyan-400" />
        正在抓正文并分段翻译…
      </div>
    );
  }

  if (state.status === "error" || !state.data) {
    return (
      <div className="mt-3 flex items-center gap-3 rounded-lg border border-rose-500/20 bg-rose-500/[0.06] px-4 py-3 text-[11px] text-rose-300">
        对照失败（网络或接口异常）。
        <button
          type="button"
          onClick={() => void load(true)}
          className="rounded border border-rose-400/30 px-2 py-0.5 font-mono text-[10px] hover:border-rose-300"
        >
          重试
        </button>
      </div>
    );
  }

  const data = state.data;
  if (!data.ok) {
    return (
      <div className="mt-3 rounded-lg border border-amber-400/20 bg-amber-400/[0.06] px-4 py-3 text-[11px] text-amber-300/90">
        {data.message}
      </div>
    );
  }

  return <CompareBody data={data} onRetry={() => void load(true)} />;
}

function CompareBody({ data, onRetry }: { data: TranslateResult; onRetry: () => void }) {
  // 没有译文时逐段标色只会骗人：绿色看起来像"质检通过"，其实什么都没翻。
  // 两种"没有译文"要分开：引擎挂了（要报警）vs 原文本来就是中文（无需翻译）。
  const noEngine = data.engine === "none" && data.needsTranslation;
  const singleColumn = noEngine || !data.needsTranslation;
  return (
    <div
      className="mt-3 rounded-lg border border-white/10 bg-black/30 p-4"
      data-testid="compare"
      data-engine={data.engine}
      data-band={data.overall.band}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 font-mono text-[10px] text-neutral-500">
        <span className="rounded border border-cyan-500/25 bg-cyan-500/[0.08] px-2 py-0.5 text-cyan-300">
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
                ? "border-cyan-500/25 text-cyan-300"
                : data.overall.band === "mid"
                  ? "border-amber-400/30 text-amber-300"
                  : "border-rose-500/30 text-rose-300")
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
            className="ml-auto text-neutral-400 underline decoration-dotted hover:text-cyan-300"
          >
            打开原页面 ↗
          </a>
        )}
      </div>

      {noEngine && (
        <p className="mt-3 rounded border border-white/10 bg-white/[0.03] px-3 py-2 text-[11px] leading-relaxed text-neutral-400">
          没有可用的翻译引擎（未配置模型，公共接口也不通），下面是分段后的原文，译文与歧义配色都没有生成。
        </p>
      )}

      {!data.needsTranslation && (
        <p className="mt-3 text-[11px] leading-relaxed text-neutral-500">
          原文本来就是中文：只做分段，不产生翻译，也就没有可标的歧义。
        </p>
      )}

      {/* 颜色图例必须自带解释：否则用户会把玫红当成"翻错了"，或把青色当成"审核通过"。 */}
      {!singleColumn && (
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[10px] text-neutral-500">
          <span className="text-neutral-400">颜色 = 该段译文的可核对差异，不是质量评分：</span>
          <span className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-sm border-l-2 border-cyan-500/60 bg-cyan-500/20" />
            低（数字/专名都对得上）
          </span>
          <span className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-sm border-l-2 border-amber-400/70 bg-amber-400/25" />
            中（有需要核对的差异）
          </span>
          <span className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-sm border-l-2 border-rose-500/70 bg-rose-500/25" />
            高（信息可能被改写或漏掉）
          </span>
        </div>
      )}

      {data.degraded.length > 0 && (
        <div className="mt-3 rounded border border-amber-400/15 bg-amber-400/[0.05] px-3 py-2 text-[10px] leading-relaxed text-amber-300/85">
          降级：{data.degraded.map(degradeText).join(" · ")}
        </div>
      )}

      {singleColumn ? (
        <ol className="mt-3 space-y-2">
          {data.segments.map((seg) => (
            <li key={seg.i}>
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
          <li key={seg.i} className="grid gap-2 md:grid-cols-2">
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
                        className="rounded border border-white/10 bg-white/[0.05] px-1.5 py-0.5 text-[9px] text-neutral-400"
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
