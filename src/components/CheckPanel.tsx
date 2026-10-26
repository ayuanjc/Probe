"use client";

import { useState } from "react";
import Link from "next/link";
import { appPath } from "@/lib/base-path";
import { STATUS_LABEL, type ClaimStatus } from "@/lib/dossier";

/**
 * 公开核验 /check 的面板。
 *
 * 它和登录后的 /verify 是两个东西，故意不共用组件：
 *   - 这里只收正文，最多 2000 字，不代抓链接（抓链接等于开免费代理）；
 *   - 一次请求一个结果（format=json），失败就是失败，不会停在 40%；
 *   - 匿名请求带 x-probe-anon: 1 —— 让「我要匿名核验」是一个主动动作；
 *   - 不落历史、不用账号额度，用独立的「每 IP 1 次/分钟 + 每天 40 次」。
 *
 * 显示的仍然是三态，不给真假判决：没有被反驳的断言，可能只是没人写过它。
 */

const MAX_CHARS = 2000;
/** 与服务端 src/app/api/verify/route.ts 的 ANON_MIN_CHARS、verify-doc 的 120 字门槛同一个数。 */
const MIN_CHARS = 120;

type JsonClaim = { claimIndex: number; quote: string; kind: string; attr: string; value: string; unit: string | null };

type VerifyScores = {
  grade: string;
  gradeReason: string;
  agreement: { value: number; low: number; high: number; n: number } | null;
  nEff: number;
  counts: { supported: number; contradicted: number; unverified: number; unverifiable: number; judged: number; verifiable: number };
  coverage: number | null;
  partial: boolean;
  blocked: string | null;
  rows: { claimIndex: number; quote: string; status: ClaimStatus; label: string; reason: string }[];
};

type JsonBody = {
  ok: boolean;
  message?: string;
  doc: { chars: number; title: string } | null;
  claims: JsonClaim[];
  scores: VerifyScores | null;
  notes: string[];
  degraded: string[];
  elapsedMs: number | null;
};

const STATUS_STYLE: Record<ClaimStatus, string> = {
  supported: "border-emerald-500/40 bg-emerald-500/10 text-emerald-300",
  contradicted: "border-red-500/40 bg-red-500/10 text-red-300",
  unverified: "border-amber-500/40 bg-amber-500/10 text-amber-300",
  unverifiable: "border-neutral-700 bg-neutral-900 text-neutral-400",
};

function pct(x: number): string {
  return (x * 100).toFixed(0) + "%";
}

export default function CheckPanel() {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [data, setData] = useState<JsonBody | null>(null);

  const tooShort = text.trim().length > 0 && text.trim().length < MIN_CHARS;
  const tooLong = text.trim().length > MAX_CHARS;

  async function run() {
    if (busy) return;
    const body = text.trim();
    // 与服务端 ANON_MIN_CHARS 同一个数：两边不一致时，用户会在中间那段字数里
    // 先被前端放行、再被后端打回「正文不足 120 字」，看起来像 bug。
    if (body.length < MIN_CHARS) {
      setErr("至少贴 " + MIN_CHARS + " 字：太短的片段里没有可被外部证实的断言。");
      return;
    }
    if (body.length > MAX_CHARS) {
      setErr("未登录一次最多 " + MAX_CHARS + " 字。");
      return;
    }
    setBusy(true);
    setErr(null);
    setData(null);
    try {
      const res = await fetch(appPath("/api/verify"), {
        method: "POST",
        headers: { "content-type": "application/json", "x-probe-anon": "1" },
        body: JSON.stringify({ text: body, format: "json" }),
      });
      const json = (await res.json()) as JsonBody;
      if (!res.ok) setErr(json.message ?? "核验失败（HTTP " + res.status + "）。");
      setData(json);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "核验失败。");
    } finally {
      setBusy(false);
    }
  }

  const scores = data?.scores ?? null;
  const agree = scores?.agreement ?? null;
  const rows = scores?.rows ?? [];
  const counts = scores?.counts ?? null;

  return (
    <div className="flex flex-col gap-4">
      <section className="rounded border border-neutral-800 bg-black p-4">
        <div className="flex items-baseline justify-between">
          <label htmlFor="check-text" className="font-mono text-[11px] text-neutral-500">
            一段正文（{MIN_CHARS}–{MAX_CHARS} 字）
          </label>
          <span className={"font-mono text-[10px] " + (tooLong ? "text-red-400" : "text-neutral-600")}>
            {text.trim().length} / {MAX_CHARS}
          </span>
        </div>
        <textarea
          id="check-text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={8}
          placeholder="粘贴一段值得核的说法：新闻导语、公告摘录、别人发给你的一段话。"
          className="mt-1 w-full resize-y rounded border border-neutral-800 bg-black/60 p-2 text-[13px] leading-relaxed text-neutral-200 outline-none focus:border-neutral-600"
        />
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={run}
            disabled={busy || tooShort || tooLong || text.trim().length === 0}
            className="rounded border border-neutral-700 bg-neutral-800 px-3 py-1.5 text-[12px] text-white transition-colors hover:border-neutral-500 disabled:opacity-40"
          >
            {busy ? "核验中…（一次核验要跑几十次上游调用，约 20–60 秒）" : "开始核验"}
          </button>
          <span className="font-mono text-[10px] leading-relaxed text-neutral-600">
            不登录：每分钟 1 次、每天 40 次，只收正文。不落历史、不需要账号。
          </span>
        </div>
      </section>

      {err ? (
        <p className="rounded border border-red-500/30 bg-red-500/10 px-3 py-2 text-[12px] text-red-400">{err}</p>
      ) : null}

      {scores && (
        <section className="rounded border border-neutral-800 bg-black p-4">
          <div className="flex flex-wrap items-baseline gap-3">
            <span className="font-mono text-[22px] text-white">{scores.grade}</span>
            <span className="text-[12px] text-neutral-400">{scores.gradeReason}</span>
          </div>
          <div className="mt-3 flex flex-wrap gap-x-6 gap-y-1 font-mono text-[11px] text-neutral-500">
            {counts && (
              <>
                <span>
                  已支持 <span className="text-emerald-300">{counts.supported}</span>
                </span>
                <span>
                  存在矛盾 <span className="text-red-300">{counts.contradicted}</span>
                </span>
                <span>
                  未找到证据 <span className="text-amber-300">{counts.unverified}</span>
                </span>
                <span>
                  不可核验 <span className="text-neutral-400">{counts.unverifiable}</span>
                </span>
                <span>
                  独立来源 <span className="text-neutral-200">{scores.nEff.toFixed(1)}</span>
                </span>
              </>
            )}
            {agree && (
              <span>
                外部吻合度 {pct(agree.value)}（{pct(agree.low)}–{pct(agree.high)}，{agree.n} 个来源）
              </span>
            )}
            {!agree && <span className="text-neutral-600">独立来源不足 2 个：不给吻合度</span>}
            {scores.coverage !== null && <span>可核验率 {pct(scores.coverage)}</span>}
            {data?.doc && <span>正文 {data.doc.chars} 字</span>}
            {data?.elapsedMs != null && <span>耗时 {(data.elapsedMs / 1000).toFixed(1)}s</span>}
          </div>
          {scores.partial && (
            <p className="mt-2 font-mono text-[10px] text-amber-500/80">
              这一轮没看全（正文被截或断言顶到上限），结论只覆盖已核的那部分。
            </p>
          )}
          {scores.blocked && (
            <p className="mt-2 font-mono text-[10px] text-neutral-500">
              {scores.blocked === "no_claims"
                ? "这段文字里没有可被外部证实或反驳的断言（观点、修辞、预测都不算）。"
                : scores.blocked === "no_evidence"
                  ? "这一轮没检索到任何外部材料，所以不下判断。"
                  : "这一轮没有可判定的断言。"}
            </p>
          )}
        </section>
      )}

      {rows.length > 0 && (
        <section className="overflow-hidden rounded border border-neutral-800">
          <ul className="flex flex-col divide-y divide-neutral-900">
            {rows.map((r) => (
              <li key={r.claimIndex} className="flex flex-col gap-1 px-3 py-2.5">
                <div className="flex items-start gap-2">
                  <span
                    className={
                      "mt-[1px] shrink-0 rounded border px-1 py-[1px] font-mono text-[10px] " + STATUS_STYLE[r.status]
                    }
                  >
                    {STATUS_LABEL[r.status]}
                  </span>
                  <p className="text-[12px] leading-relaxed text-neutral-300">{r.quote}</p>
                </div>
                {r.reason ? (
                  <p className="pl-1 font-mono text-[10px] leading-relaxed text-neutral-600">{r.reason}</p>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      )}

      {data?.ok && (
        <p className="font-mono text-[10px] leading-relaxed text-neutral-600">
          判定由模型给出，可能出错；结论请以原始信源为准。
          想核整篇长文、用链接、留历史，<Link href="/login" className="text-blue-400 hover:text-blue-300">登录</Link>后用完整版。
        </p>
      )}
    </div>
  );
}
