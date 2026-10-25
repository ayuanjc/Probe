"use client";

import { useCallback, useRef, useState } from "react";
import { appPath } from "@/lib/base-path";
import type { Claim } from "@/lib/schemas";
import type { DossierResult } from "@/lib/dossier";

/**
 * 结果页的「核验这一轮」。
 *
 * 单独一个 hook 而不是塞进 useProbe：核验是**用户点出来的第二次请求**，
 * 与首屏那条 SSE 各自独立 —— 重跑核验不该重放整轮检索，换条查询则必须丢掉旧结论
 * （否则界面上会出现「新查询 + 旧吻合度」这种自相矛盾的画面）。
 */
export type EvidenceView =
  | { status: "idle" }
  | { status: "running" }
  | {
      status: "done";
      result: DossierResult;
      /** 额外一种：本机没配留出集检索器，压根没法核（不是「核了没找到」）。 */
      blocked: "no_evidence" | "all_unverifiable" | "no_heldout_retriever" | null;
      message: string | null;
      notJudged: number;
      kept: number;
      skipped: number;
      degraded: string[];
      elapsedMs: number;
      /** 服务端落的校准样本 id；拿到它界面才能贴「对/错」标签。 */
      sampleId: string | null;
    }
  | { status: "failed"; error: string };

const IDLE: EvidenceView = { status: "idle" };

export function useEvidence() {
  const [view, setView] = useState<EvidenceView>(IDLE);
  /**
   * 代次：一次新检索就把代次加一，正在飞的那次回来时直接丢掉。
   * 没有它的话，「A 的核验还在路上 → 用户已经切到 B」会把 A 的结论贴到 B 上。
   */
  const genRef = useRef(0);

  const reset = useCallback(() => {
    genRef.current += 1;
    setView(IDLE);
  }, []);

  const run = useCallback(async (claims: Claim[], citedOwners: string[]) => {
    if (claims.length === 0) return;
    const gen = genRef.current + 1;
    genRef.current = gen;
    setView({ status: "running" });

    try {
      const res = await fetch(appPath("/api/evidence"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ claims: claims.slice(0, 40), citedOwners }),
      });
      const body = (await res.json().catch(() => null)) as
        | {
            ok?: boolean;
            message?: string | null;
            blocked?: EvidenceView extends never ? never : "no_evidence" | "all_unverifiable" | "no_heldout_retriever" | null;
            result?: DossierResult;
            gate?: { kept: number; skipped: number };
            sampleId?: string | null;
            notJudged?: number;
            degraded?: string[];
            elapsedMs?: number;
          }
        | null;

      if (genRef.current !== gen) return;
      if (!res.ok || !body || body.ok !== true || !body.result) {
        setView({
          status: "failed",
          error: body?.message || "核验请求被拒（" + res.status + "）。",
        });
        return;
      }

      setView({
        status: "done",
        result: body.result,
        blocked: body.blocked ?? null,
        message: body.message ?? null,
        notJudged: body.notJudged ?? 0,
        kept: body.gate?.kept ?? 0,
        skipped: body.gate?.skipped ?? 0,
        degraded: body.degraded ?? [],
        elapsedMs: body.elapsedMs ?? 0,
        sampleId: body.sampleId ?? null,
      });
    } catch {
      if (genRef.current !== gen) return;
      setView({ status: "failed", error: "网络出错：核验请求没有送达。" });
    }
  }, []);

  return { view, run, reset };
}
