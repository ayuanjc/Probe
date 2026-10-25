"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { appPath } from "@/lib/base-path";
import type { MetricsSnapshot, RunView } from "@/lib/metrics";

type Payload = MetricsSnapshot & {
  redaction: { redacted: boolean; keyConfigured: boolean; hint: string };
};

/**
 * 可观测性面板（PRD 附录 B）。它回答的是「刚才那几轮跑得怎么样」，
 * 不是「这台服务长期健不健康」—— 数据只在内存里，重启即清空，
 * 这句话必须写在界面上，否则会被当成监控看板用。
 */

function Bar({ value, max, tone = "blue" }: { value: number; max: number; tone?: "blue" | "neutral" }) {
  const pct = max <= 0 ? 0 : Math.max(2, Math.round((value / max) * 100));
  return (
    <div className="h-1 w-full overflow-hidden rounded-full bg-neutral-900">
      <div
        className={tone === "blue" ? "h-full rounded-full bg-blue-500" : "h-full rounded-full bg-neutral-600"}
        style={{ width: pct + "%" }}
      />
    </div>
  );
}

function Cell({ label, value, hint, accent }: { label: string; value: string; hint?: string; accent?: boolean }) {
  return (
    <div className="rounded-md border border-neutral-800 bg-[#0f0f0f] px-4 py-3">
      <div className="text-[9px] uppercase tracking-[0.16em] text-neutral-600">{label}</div>
      <div className={"mt-1 font-mono text-lg font-semibold tabular-nums " + (accent ? "text-blue-500" : "text-white")}>{value}</div>
      {hint ? <div className="mt-0.5 text-[10px] text-neutral-600">{hint}</div> : null}
    </div>
  );
}

const STAGE_LABEL: Record<string, string> = {
  route: "意图（规则 + 模型精修）",
  retrieve: "检索（4 路并发）",
  analyze: "分析（去重 → 断言 → 数据集）",
  compose: "编排（选图 + 白名单校验）",
  summary: "摘要（流式）",
};

function fmtMs(ms: number): string {
  if (ms >= 1000) return (ms / 1000).toFixed(2) + "s";
  return Math.round(ms) + "ms";
}

function fmtTime(at: number): string {
  const d = new Date(at);
  const p = (n: number) => String(n).padStart(2, "0");
  return p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
}

export default function MetricsPanel() {
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [auto, setAuto] = useState(true);
  const [loading, setLoading] = useState(false);

  /**
   * 自动刷新每 5 秒一次，而 /api/metrics 在慢机器上可能超过 5 秒。
   * 上一次还没回来就再发一次，两次响应到达顺序不定 —— 早发晚到的那个会把
   * 新数字盖回旧的，界面表现为「计数往回跳」。所以只认最新一次的结果。
   */
  const reqSeq = useRef(0);

  const load = useCallback(async () => {
    reqSeq.current += 1;
    const seq = reqSeq.current;
    setLoading(true);
    try {
      const res = await fetch(appPath("/api/metrics"), { cache: "no-store" });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const next = (await res.json()) as Payload;
      if (seq !== reqSeq.current) return;
      setData(next);
      setError(null);
    } catch (err) {
      if (seq !== reqSeq.current) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (seq === reqSeq.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!auto) return;
    const timer = window.setInterval(() => void load(), 5000);
    return () => window.clearInterval(timer);
  }, [auto, load]);

  if (error && !data) {
    return (
      <div className="rounded-md border border-red-500/30 bg-red-500/[0.06] px-4 py-3 text-xs text-red-400">
        指标读取失败：{error}
      </div>
    );
  }

  if (!data) return <p className="text-xs text-neutral-600">读取中…</p>;

  const empty = data.kept === 0;
  const stageMax = Math.max(1, ...data.stages.map((s) => s.p95));
  const confTotal = data.confidence.low + data.confidence.medium + data.confidence.high + data.confidence.none;
  const degradeMax = Math.max(1, ...data.degraded.map((d) => d.count));

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-[11px] leading-relaxed text-neutral-500">
          只统计本进程启动以来的最近 {data.cap} 轮（当前 {data.kept} / 累计 {data.total}）。重启即清空，不落盘。
        </p>
        <div className="flex items-center gap-3">
          <label className="flex cursor-pointer items-center gap-2 font-mono text-[11px] text-neutral-500">
            <input
              type="checkbox"
              checked={auto}
              onChange={(e) => setAuto(e.target.checked)}
              className="h-3 w-3 accent-blue-500"
            />
            每 5 秒刷新
          </label>
          <button
            type="button"
            onClick={() => void load()}
            disabled={loading}
            className="rounded-md border border-neutral-800 px-3 py-1 font-mono text-[11px] text-neutral-400 transition-colors hover:border-neutral-600 hover:text-white disabled:text-neutral-700"
          >
            {loading ? "刷新中…" : "刷新"}
          </button>
        </div>
      </div>

      {empty ? (
        <div className="rounded-md border border-neutral-800 bg-[#0f0f0f] px-4 py-8 text-center text-xs text-neutral-500">
          这一进程还没有跑过检索。回终端问一句，指标就会出现在这里。
        </div>
      ) : (
        <>
          <section className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
            <Cell label="端到端 p50" value={fmtMs(data.latency.p50)} />
            <Cell label="端到端 p95" value={fmtMs(data.latency.p95)} accent />
            <Cell label="最慢一轮" value={fmtMs(data.latency.max)} />
            <Cell label="中断" value={String(data.flags.aborted)} hint="客户端断开" />
            <Cell label="演示样本" value={String(data.flags.demoOnly)} hint="全部实时源失败" />
            <Cell label="有失败模块" value={String(data.flags.withErrors)} hint="降级为表格" />
          </section>

          <section className="panel p-5">
            <h2 className="text-sm font-semibold text-white">阶段耗时</h2>
            <p className="mt-1 text-[11px] text-neutral-600">
              每一格是该阶段在本进程内的 p50 / p95。检索与模型是两件不同的事，混在一起看会误判瓶颈。
            </p>
            <table className="mt-4 w-full text-left">
              <thead>
                <tr className="border-b border-neutral-800 text-[9px] uppercase tracking-[0.16em] text-neutral-600">
                  <th className="pb-2 font-normal">阶段</th>
                  <th className="pb-2 font-normal">样本</th>
                  <th className="pb-2 font-normal">p50</th>
                  <th className="pb-2 font-normal">p95</th>
                  <th className="w-[28%] pb-2 font-normal">分布</th>
                </tr>
              </thead>
              <tbody>
                {data.stages.map((s) => (
                  <tr key={s.stage} className="border-b border-neutral-800/60">
                    <td className="py-2 text-[13px] text-neutral-300">{STAGE_LABEL[s.stage] ?? s.stage}</td>
                    <td className="py-2 font-mono text-xs tabular-nums text-neutral-500">{s.n}</td>
                    <td className="py-2 font-mono text-xs tabular-nums text-neutral-300">{fmtMs(s.p50)}</td>
                    <td className="py-2 font-mono text-xs tabular-nums text-white">{fmtMs(s.p95)}</td>
                    <td className="py-2 pr-2"><Bar value={s.p95} max={stageMax} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <section className="panel p-5">
              <h2 className="text-sm font-semibold text-white">置信度分布</h2>
              <p className="mt-1 text-[11px] text-neutral-600">
                平均 {confTotal === 0 ? "—" : data.confidence.avg.toFixed(3)}（未评的轮次不计入平均）
              </p>
              <div className="mt-4 flex flex-col gap-3">
                {([
                  ["高（≥0.75）", data.confidence.high, "blue"],
                  ["中（0.50–0.75）", data.confidence.medium, "blue"],
                  ["低（<0.50）", data.confidence.low, "neutral"],
                  ["未评（没有面板）", data.confidence.none, "neutral"],
                ] as Array<[string, number, "blue" | "neutral"]>).map(([label, n, tone]) => (
                  <div key={label}>
                    <div className="flex items-center justify-between text-[11px]">
                      <span className="text-neutral-400">{label}</span>
                      <span className="font-mono tabular-nums text-neutral-300">{n}</span>
                    </div>
                    <div className="mt-1.5"><Bar value={n} max={Math.max(1, confTotal)} tone={tone} /></div>
                  </div>
                ))}
              </div>
            </section>

            <section className="panel p-5">
              <h2 className="text-sm font-semibold text-white">降级码</h2>
              <p className="mt-1 text-[11px] text-neutral-600">
                每次降级都留了码（来源、原因）。这里按出现轮次排序 —— 高频码就是下一轮该修的东西。
              </p>
              {data.degraded.length === 0 ? (
                <p className="mt-4 text-xs text-neutral-600">最近这些轮次没有降级。</p>
              ) : (
                <ul className="mt-4 flex flex-col gap-2">
                  {data.degraded.slice(0, 8).map((d) => (
                    <li key={d.code} className="flex items-center gap-3">
                      <code className="min-w-0 flex-1 truncate font-mono text-[11px] text-neutral-400">{d.code}</code>
                      <span className="font-mono text-[11px] tabular-nums text-neutral-500">{d.count} 轮</span>
                      <div className="w-16"><Bar value={d.count} max={degradeMax} tone="neutral" /></div>
                    </li>
                  ))}
                </ul>
              )}
              <div className="mt-4 border-t border-neutral-800 pt-3 text-[11px] text-neutral-600">
                模型调用 {data.usage.calls} 次（结构化 {data.usage.structured} / 摘要 {data.usage.summary}）·
                输入 {data.usage.promptChars.toLocaleString("en-US")} 字 ·
                输出 {data.usage.outputChars.toLocaleString("en-US")} 字
                {data.usage.measured === 0
                  ? " · token 数未由 SDK 提供，因此不显示估算值冒充测量值"
                  : " · token 输入 " + data.usage.tokensIn.toLocaleString("en-US") + " / 输出 " + data.usage.tokensOut.toLocaleString("en-US")}
              </div>
            </section>
          </div>

          <section className="panel overflow-hidden">
            <div className="flex flex-wrap items-center justify-between gap-2 px-5 pb-1 pt-4">
              <h2 className="text-sm font-semibold text-white">最近运行</h2>
              <span className="font-mono text-[10px] text-neutral-600">
                {data.redaction.redacted ? "查询词已脱敏" : "查询词可见（PROBE_METRICS_KEY 已匹配）"}
              </span>
            </div>
            {data.redaction.redacted ? (
              <p className="px-5 pb-2 text-[11px] leading-relaxed text-neutral-600">{data.redaction.hint}</p>
            ) : null}
            <div className="scroll-thin max-h-[420px] overflow-auto px-5 pb-5">
              <table className="w-full text-left">
                <thead className="sticky top-0 bg-[#111]">
                  <tr className="border-b border-neutral-800 text-[9px] uppercase tracking-[0.16em] text-neutral-600">
                    <th className="py-2 font-normal">时间</th>
                    <th className="py-2 font-normal">查询</th>
                    <th className="py-2 font-normal">耗时</th>
                    <th className="py-2 font-normal">条目 / 稿源</th>
                    <th className="py-2 font-normal">置信度</th>
                    <th className="py-2 font-normal">模块</th>
                    <th className="py-2 font-normal">状态</th>
                  </tr>
                </thead>
                <tbody>
                  {data.runs.map((r: RunView) => (
                    <tr key={r.id} className="border-b border-neutral-800/60 align-top">
                      <td className="py-2 font-mono text-[11px] tabular-nums text-neutral-600">{fmtTime(r.at)}</td>
                      <td className="max-w-[260px] truncate py-2 text-[12px] text-neutral-300">{r.query}</td>
                      <td className="py-2 font-mono text-[11px] tabular-nums text-neutral-400">{fmtMs(r.totalMs)}</td>
                      <td className="py-2 font-mono text-[11px] tabular-nums text-neutral-400">
                        {r.sources} / {r.owners}
                      </td>
                      <td className="py-2 font-mono text-[11px] tabular-nums text-neutral-300">
                        {r.band === "none" ? "—" : r.confidence.toFixed(2) + " " + r.band}
                      </td>
                      <td className="py-2 font-mono text-[11px] tabular-nums text-neutral-400">
                        {r.modules}
                        {r.moduleErrors > 0 ? <span className="text-yellow-500"> · {r.moduleErrors} 失败</span> : null}
                      </td>
                      <td className="py-2 text-[11px]">
                        {r.aborted ? <span className="text-neutral-600">中断</span> : null}
                        {r.demoOnly ? <span className="text-yellow-500">演示样本</span> : null}
                        {!r.aborted && !r.demoOnly && r.degraded.length > 0 ? (
                          <span className="text-neutral-500">{r.degraded.length} 降级</span>
                        ) : null}
                        {!r.aborted && !r.demoOnly && r.degraded.length === 0 ? <span className="text-neutral-700">—</span> : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </div>
  );
}