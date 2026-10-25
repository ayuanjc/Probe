"use client";

import { useState } from "react";
import { Loader2, ShieldQuestion } from "lucide-react";
import { appPath } from "@/lib/base-path";
import DossierCard from "./DossierCard";
import type { EvidenceView } from "@/hooks/useEvidence";

/**
 * 结果页的「核验这一轮」。
 *
 * 它出现在信源之上、共现图之下：读者刚看完「这轮检索说了什么」，
 * 下一个自然问题就是「这些话有别人作证吗」。
 *
 * 三条界面上不妥协的地方：
 * 1. **不许自动跑**。核验要跑十几次上游、几十秒，一次检索就顺手触发等于把
 *    首屏的钱花在用户没要的东西上；按钮在，用户点，才跑。
 * 2. **没核验就什么都不显示数字**。idle 状态只说明「能做什么」，
 *    不预告「大概多少吻合」—— 预告的数字最后一定会被当成结论。
 * 3. **没留出集就直说没有**。本机没配检索 key 时给的是「没有留出集就没有吻合度」，
 *    而不是 0% 或者「暂无数据」。0% 会被读成「所有断言都被反驳了」。
 */

/**
 * 贴标签：这一轮结论成立不成立。
 *
 * 它是 ECE 的唯一数据来源 —— 没有人工对错，「吻合度 79%」就永远只是一个分数，
 * 没人知道 79% 到底意味着八成对还是六成对。
 *
 * 三条克制：不接受「不确定」（不确定就别点，混进来等于往校准里灌噪声）、
 * 不改这一轮已显示的数字（否则先看结论再标对错，等于自己给自己打分）、
 * 记不住时明说记不住，而不是默默成功。
 */
function LabelRow({ sampleId }: { sampleId: string | null }) {
  const [state, setState] = useState<"idle" | "saving" | "saved" | "failed">("idle");
  const [answer, setAnswer] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function send(correct: boolean) {
    if (!sampleId || state === "saving") return;
    setState("saving");
    setError(null);
    try {
      const res = await fetch(appPath("/api/calibration"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: sampleId, correct }),
      });
      const body = (await res.json().catch(() => null)) as
        | { ok?: boolean; message?: string }
        | null;
      if (!res.ok || !body || body.ok !== true) {
        setState("failed");
        setError(body?.message || "记不上了（" + res.status + "）。");
        return;
      }
      setAnswer(correct);
      setState("saved");
    } catch {
      setState("failed");
      setError("网络出错，标记没送到。");
    }
  }

  if (!sampleId) {
    return (
      <p className="font-mono text-[11px] text-neutral-600">
        这一轮没有样本编号（记账失败），贴不了标签 —— 校准那边少一条观测。
      </p>
    );
  }

  if (state === "saved") {
    return (
      <p className="font-mono text-[11px] text-emerald-500">
        已记下：{answer ? "结论成立" : "结论不成立"}。只进校准，不改上面任何数字。
      </p>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2 border-t border-neutral-800 pt-2">
      <span className="text-[11px] text-neutral-500">
        这一轮的结论成立吗？
        <span className="ml-1 text-neutral-600">（只用来量校准偏差，不回头改上面的数字）</span>
      </span>
      <button
        type="button"
        onClick={() => void send(true)}
        disabled={state === "saving"}
        className="rounded border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 font-mono text-[11px] text-emerald-500 transition-colors hover:bg-emerald-500/20 disabled:opacity-50"
      >
        成立
      </button>
      <button
        type="button"
        onClick={() => void send(false)}
        disabled={state === "saving"}
        className="rounded border border-red-500/30 bg-red-500/10 px-2 py-0.5 font-mono text-[11px] text-red-500 transition-colors hover:bg-red-500/20 disabled:opacity-50"
      >
        不成立
      </button>
      {state === "saving" ? <span className="text-[11px] text-neutral-500">记录中…</span> : null}
      {state === "failed" && error ? <span className="text-[11px] text-red-500">{error}</span> : null}
    </div>
  );
}

const STATUS_TEXT: Record<EvidenceView["status"], string> = {
  idle: "核验",
  running: "核验中…",
  done: "重新核验",
  failed: "再试一次",
};

export default function EvidencePanel(props: {
  view: EvidenceView;
  claimCount: number;
  onRun: () => void;
}) {
  const { view, claimCount, onRun } = props;
  const busy = view.status === "running";
  const label = view.status === "idle" ? "核验 " + claimCount + " 条" : STATUS_TEXT[view.status];

  return (
    <section className="panel overflow-hidden">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-neutral-800 px-4 py-3">
        <div className="flex items-center gap-2">
          <ShieldQuestion size={15} className="text-neutral-500" />
          <h2 className="text-sm text-white">断言核验</h2>
          <span className="font-mono text-[11px] text-neutral-500">
            只采信本轮没引用过的来源
          </span>
        </div>
        <button
          type="button"
          onClick={onRun}
          disabled={busy || claimCount === 0}
          className="inline-flex items-center gap-1.5 rounded border border-neutral-700 px-2.5 py-1 font-mono text-[11px] text-neutral-300 transition-colors hover:border-neutral-500 hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? <Loader2 size={12} className="animate-spin" /> : null}
          {label}
        </button>
      </header>

      <div className="px-4 py-3 text-[12px] leading-relaxed text-neutral-400">
        {view.status === "idle" ? (
          <div className="space-y-1">
            <p>
              逐条去<span className="text-neutral-200">留出集</span>里找证词 —— 也就是本轮检索没引用的来源。
              自己引自己不算证据，所以这里的数字只会比「看着很一致」低。
            </p>
            <p className="text-neutral-500">
              只核值得核的（带数字、带主体、带时间的）断言，最多 12 条。要跑十几次上游，慢是正常的。
            </p>
          </div>
        ) : null}

        {view.status === "running" ? (
          <p className="text-neutral-500">正在逐条检索留出集…</p>
        ) : null}

        {view.status === "failed" ? (
          <p className="text-red-500">{view.error}</p>
        ) : null}

        {view.status === "done" ? (
          <div className="space-y-3">
            {view.message ? (
              <p className="rounded border border-yellow-500/25 bg-yellow-500/5 px-2.5 py-1.5 text-yellow-500/90">
                {view.message}
              </p>
            ) : null}

            <DossierCard result={view.result} />

            <LabelRow sampleId={view.sampleId} />

            {view.notJudged > 0 ? (
              <p className="font-mono text-[11px] text-neutral-500">
                另有 {view.notJudged} 条断言这一轮没核（闸门或预算所限），不计入上面任何分母。
              </p>
            ) : null}

            {view.skipped > 0 ? (
              <p className="font-mono text-[11px] text-neutral-500">
                闸门跳过 {view.skipped} 条：缺数字/缺主体的断言，核起来只会烧钱。
              </p>
            ) : null}

            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[10px] text-neutral-600">
              <span>耗时 {view.elapsedMs}ms</span>
              <span>核验 {view.kept} 条</span>
              {view.degraded.length > 0 ? (
                <details className="w-full">
                  <summary className="cursor-pointer text-neutral-500">
                    降级 {view.degraded.length} 项
                  </summary>
                  <ul className="mt-1 space-y-0.5 break-all">
                    {view.degraded.map((d) => (
                      <li key={d}>{d}</li>
                    ))}
                  </ul>
                </details>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>
    </section>
  );
}
