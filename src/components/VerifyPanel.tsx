"use client";

import { useState } from "react";
import { appPath } from "@/lib/base-path";
import { coverageGapText, type VerifyScoresEvent } from "@/lib/verify-events";
import { N_A_LABEL } from "@/lib/grade";
import { STATUS_LABEL, type ClaimStatus } from "@/lib/dossier";
import WhatIsThis from "@/components/WhatIsThis";

/**
 * 文档核验面板。
 *
 * 走 /api/verify 的 format=json 单次模式，不用 SSE：这一页要的是「跑完看结论」，
 * 中间那几十个事件对用户没有信息量，倒是对错误处理有要求 —— 一次请求一个结果，
 * 失败就是失败，不会出现「流断在中间，界面停在 40%」。
 *
 * 界面契约（分析文档 §8）在这页上是这样落的：三可见（吻合度 + 区间、独立源数、
 * 警示），其余进 detail。评级 N/A 时**不显示任何百分比**。
 */

type JsonClaim = {
  claimIndex: number;
  segmentIdx: number;
  quote: string;
  kind: string;
  attr: string;
  value: string;
  unit: string | null;
  charStart: number;
  charEnd: number;
};

type JsonBody = {
  ok: boolean;
  message?: string;
  doc: { docId: string; title: string; chars: number; truncated: boolean; segmentCount: number } | null;
  claims: JsonClaim[];
  dropped: string[];
  nli: { claimIndex: number; evidenceId: string; label: string; authority: number }[];
  scores: VerifyScoresEvent | null;
  notes: string[];
  degraded: string[];
  elapsedMs: number | null;
  stats: Record<string, number> | null;
};

/** 状态码 → 人话。只说事实，不说「很抱歉」。 */
const NOTE_TEXT: Record<string, string> = {
  "claims:unavailable": "没接模型，本轮抽不出断言 —— 这是我们的配置问题，不是文章的问题。",
  "claims:none": "这一轮没抽出任何可核验的断言。",
  "claims:no_retriever": "没有配置外部检索，留出集为空，所以只给可核验率，不给吻合度。",
  "claims:pending_phase2": "断言抽取还没接上。",
};

const STATUS_STYLE: Record<ClaimStatus, string> = {
  supported: "text-emerald-500 border-emerald-500/30 bg-emerald-500/10",
  contradicted: "text-red-500 border-red-500/30 bg-red-500/10",
  unverified: "text-neutral-400 border-neutral-700 bg-neutral-800/40",
  unverifiable: "text-neutral-500 border-dashed border-neutral-700 bg-transparent",
};

function pct(x: number): string {
  return (x * 100).toFixed(0) + "%";
}

const VERIFY_POINTS = [
  {
    k: "先找证据，再谈判断",
    v: "把正文拆成一句句可被外部证实或反驳的断言，逐条去留出集里找原文作证；找不到就如实记「未找到证据」。",
  },
  {
    k: "三态，而且「没找到」不算「假」",
    v: "每条断言判成支持 / 矛盾 / 无法判定。没有被反驳的，很可能只是没人写过它 —— 我们不会替你说成「查无此事」。",
  },
  {
    k: "给区间，不给一个漂亮数字",
    v: "独立来源太少时不给吻合度，只给可核验率；样本不够就写 N/A —— 一个来源的吻合度不是吻合度。",
  },
];
export default function VerifyPanel() {
  const [text, setText] = useState("");
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [data, setData] = useState<JsonBody | null>(null);

  async function run() {
    if (busy) return;
    setBusy(true);
    setErr(null);
    setData(null);
    try {
      const payload = text.trim() ? { text: text.trim(), format: "json" } : { url: url.trim(), format: "json" };
      if (!payload.text && !payload.url) {
        setErr("给一篇正文，或给一个文章链接。");
        return;
      }
      const res = await fetch(appPath("/api/verify"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = (await res.json()) as JsonBody;
      if (!res.ok) setErr(body.message ?? "核验失败（HTTP " + res.status + "）。");
      setData(body);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "核验失败。");
    } finally {
      setBusy(false);
    }
  }

  const scores = data?.scores ?? null;
  const agree = scores?.agreement ?? null;
  const tooFew = (scores?.nEff ?? 0) < 2;
  const claimsByIdx = new Map((data?.claims ?? []).map((c) => [c.claimIndex, c]));

  return (
    <main className="mx-auto max-w-3xl px-4 py-8 text-neutral-300">
      <h1 className="text-lg text-white">文档核验</h1>
      <p className="mt-1 text-[12px] leading-relaxed text-neutral-500">
        把一篇文章拆成可以被外部材料证实或反驳的断言，逐条去留出集里核对。
        给的是「外部吻合度」，不是真假判决：一条断言没有被反驳，也可能只是没人写过它。
      </p>

      <div className="mt-4">
        <WhatIsThis
          title="这三个数字是怎么来的？"
          intro={
            <p className="text-[12px] leading-relaxed text-neutral-300">
              下面这一页只做一件事：把一篇文章里的断言拎出来，逐条去外部材料里核对，
              然后老老实实告诉你「证据站在哪一边、站在几条上」。
            </p>
          }
          points={VERIFY_POINTS}
          note="核验结果由模型判定，可能出错；结论请以原始信源为准。"
        />
      </div>
      <section className="mt-5 rounded-md border border-neutral-800 bg-[#111] p-4">
        <label className="block font-mono text-[11px] text-neutral-500">正文</label>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={6}
          placeholder="粘贴一篇正文（至少 120 字）"
          className="mt-1 w-full resize-y rounded border border-neutral-800 bg-black/40 p-2 text-[13px] text-neutral-200 outline-none focus:border-neutral-600"
        />
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <label className="font-mono text-[11px] text-neutral-500">或链接</label>
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://"
            className="min-w-0 flex-1 rounded border border-neutral-800 bg-black/40 px-2 py-1 font-mono text-[12px] text-neutral-200 outline-none focus:border-neutral-600"
          />
          <button
            type="button"
            onClick={run}
            disabled={busy}
            className="rounded border border-neutral-700 bg-neutral-800 px-3 py-1 text-[12px] text-white disabled:opacity-50"
          >
            {busy ? "核验中…" : "开始核验"}
          </button>
        </div>
        <p className="mt-2 font-mono text-[10px] text-neutral-600">
          有正文时优先用正文。限流 2 次/分钟：一次核验本身就要跑几十次上游调用。
        </p>
      </section>

      {err ? (
        <p className="mt-4 rounded border border-red-500/30 bg-red-500/10 px-3 py-2 text-[12px] text-red-400">{err}</p>
      ) : null}

      {data && !data.ok && data.message ? (
        <p className="mt-4 rounded border border-red-500/30 bg-red-500/10 px-3 py-2 text-[12px] text-red-400">{data.message}</p>
      ) : null}

      {scores ? (
        <section className="mt-4 rounded-md border border-neutral-800 bg-[#111] p-4 text-[12px] leading-relaxed text-neutral-400">
          <header className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <h2 className="text-white">评级</h2>
              <span className="rounded border border-neutral-700 px-2 py-0.5 font-mono text-[13px] text-white">
                {scores.grade}
              </span>
              {scores.capped ? (
                <span className="rounded border border-yellow-500/30 bg-yellow-500/10 px-1.5 py-0.5 font-mono text-[10px] text-yellow-500">
                  有权威反证
                </span>
              ) : null}
            </div>
            <div className="font-mono text-[11px] text-neutral-500">
              已判定 {scores.counts.judged} / 可核验 {scores.counts.verifiable} · 不可核 {scores.counts.unverifiable}
            </div>
          </header>

          <p className="text-[11px] text-neutral-500">
            {N_A_LABEL[scores.gradeReason] ??
              (scores.capped
                ? "原本可以更高，但因为有多家权威来源同时反驳，压到了 B。谢谢它们。"
                : "字母档只是把四个口径压成一个便于扫读的符号，下面的数字才是依据。")}
          </p>

          {/* 主数字：吻合度 + 区间。N/A 或独立源不足时不给百分比。 */}
          {agree && !tooFew ? (
            <div className="mt-3 flex items-end gap-3">
              <div className="font-mono text-3xl font-bold tabular-nums text-blue-500">{pct(agree.value)}</div>
              <div className="pb-1 font-mono text-[11px] text-neutral-500">
                95% 区间 {pct(agree.low)}–{pct(agree.high)}
              </div>
              <div
                className="mb-0.5 ml-auto rounded border border-neutral-700 px-2 py-0.5 font-mono text-[11px] text-neutral-300"
                title="有效独立源数 = (Σw)² / Σw²；转载按 0.3 计，同一 owner 只算一票"
              >
                ≈{scores.nEff.toFixed(1)} 个独立源
              </div>
            </div>
          ) : (
            <div className="mt-3 flex items-end gap-3">
              <div className="text-lg text-neutral-300">
                {scores.blocked === "aborted"
                  ? "核验已取消"
                  : tooFew && agree
                    ? "无独立证据"
                    : "本轮无外部核验"}
              </div>
              <div className="pb-1 font-mono text-[11px] text-neutral-500">≈{scores.nEff.toFixed(1)} 个独立源</div>
            </div>
          )}

          <p className="mt-2 text-[11px] text-neutral-500">
            {scores.blocked === "aborted"
              ? "核验中途被取消（页面关闭或请求中断）—— 这不是这篇文章的问题，重跑一次即可。"
              : tooFew && agree
              ? "只有一个独立来源投票，给不出区间 —— 一个来源的吻合度不是吻合度。"
              : agree
                ? "外部证据对本文断言的加权支持比例，不是真假判决。"
                : scores.blocked === "all_unverifiable"
                  ? "本轮断言全部是因果 / 观点 / 预测类，按定义不可核验 —— 只有可核验率有意义。"
                  : "本轮没有带回任何留出集证据：显示「没有核过」，不显示 0 分。"}
          </p>

          <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 font-mono text-[11px] text-neutral-500 sm:grid-cols-4">
            <div>
              <dt className="text-neutral-600">可核验率</dt>
              <dd className="text-neutral-300">{scores.coverage === null ? "—" : pct(scores.coverage)}</dd>
            </div>
            <div>
              <dt className="text-neutral-600">支持 / 矛盾</dt>
              <dd className="text-neutral-300">
                {scores.counts.supported} / {scores.counts.contradicted}
              </dd>
            </div>
            <div>
              <dt className="text-neutral-600">未找到证据</dt>
              <dd className="text-neutral-300">{scores.counts.unverified}</dd>
            </div>
            <div>
              <dt className="text-neutral-600">耗时</dt>
              <dd className="text-neutral-300">{data?.elapsedMs === null ? "—" : ((data?.elapsedMs ?? 0) / 1000).toFixed(1) + "s"}</dd>
            </div>
          </dl>

          {scores.partialReasons.length > 0 ? (
            <p className="mt-2 rounded border border-yellow-500/30 bg-yellow-500/10 px-2 py-1 font-mono text-[10px] text-yellow-500">
              只覆盖了一部分：
              {scores.partialReasons.map((g) => coverageGapText(g)).join("；")}。
              字母档代表的是核过的那部分，不是整篇。
            </p>
          ) : null}
          {scores.aborted ? (
            <p className="mt-2 rounded border border-neutral-700 bg-neutral-900/60 px-2 py-1 font-mono text-[10px] text-neutral-400">
              你在跑完前取消了 —— 上面是停下那一刻的结果，不是这篇的定论。
            </p>
          ) : null}
        </section>
      ) : null}

      {scores && scores.rows.length > 0 ? (
        <section className="mt-4 rounded-md border border-neutral-800 bg-[#111] p-4">
          <h2 className="mb-2 text-[12px] text-white">逐条断言</h2>
          <ul className="space-y-2">
            {scores.rows.map((row) => {
              const c = claimsByIdx.get(row.claimIndex);
              return (
                <li key={row.claimIndex} className="rounded border border-neutral-800 bg-black/20 p-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={"rounded border px-1.5 py-0.5 text-[10px] " + STATUS_STYLE[row.status]}>
                      {STATUS_LABEL[row.status]}
                    </span>
                    <span className="font-mono text-[12px] text-neutral-200">
                      {c ? c.attr + " = " + c.value + (c.unit ? " " + c.unit : "") : "—"}
                    </span>
                    {c ? <span className="font-mono text-[10px] text-neutral-600">{c.kind}</span> : null}
                  </div>
                  <p className="mt-1 border-l-2 border-neutral-800 pl-2 text-[11px] leading-relaxed text-neutral-500">
                    {c ? c.quote : row.quote}
                  </p>
                  {row.reason ? <p className="mt-1 text-[10px] text-neutral-600">{row.reason}</p> : null}
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      {data ? (
        <details className="mt-4 rounded-md border border-neutral-800 bg-[#111] p-3 text-[11px] text-neutral-500">
          <summary className="cursor-pointer text-neutral-400">诊断（notes / degraded / 丢掉的断言）</summary>
          <ul className="mt-2 space-y-1">
            {(data.notes ?? []).map((n) => (
              <li key={n} className="font-mono text-[10px] text-neutral-400">
                {n} — {NOTE_TEXT[n] ?? "见文档"}
              </li>
            ))}
            {(data.degraded ?? []).map((d, i) => (
              <li key={d + i} className="font-mono text-[10px] text-neutral-600">
                {d}
              </li>
            ))}
            {data.dropped.length > 0 ? (
              <li className="font-mono text-[10px] text-neutral-600">
                服务端复核丢掉 {data.dropped.length} 条：{data.dropped.join(", ")}
              </li>
            ) : null}
            {data.stats ? (
              <li className="font-mono text-[10px] text-neutral-600">
                stats {JSON.stringify(data.stats)}
              </li>
            ) : null}
          </ul>
        </details>
      ) : null}
    </main>
  );
}
