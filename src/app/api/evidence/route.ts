import { z } from "zod";
import { ClaimSchema } from "@/lib/schemas";
import { buildDossier, pickJudged } from "@/lib/dossier";
import { authorityOf } from "@/lib/authority";
import { createGate, createLimiter, readPositiveInt } from "@/lib/rate-limit";
import {
  clientKey,
  isCrossSite,
  publicMessage,
  rateLimited,
  readJsonBody,
} from "@/lib/request-guard";
import { requireUser } from "@/lib/auth/guard";
import { llmJudge, verifyClaims } from "@/agents/verify";
import { makeHeldoutDeps } from "@/agents/heldout";
import { selectVerifiable } from "@/lib/check-worthy";
import { recordSample } from "@/lib/calibration-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 搜索结果页的「断言核验」入口：给一批断言，自己去外部找留出集、逐条判三态、
 * 再把账交给 buildDossier 算吻合度。
 *
 * 为什么是独立接口而不是塞进 /api/search 的 SSE：
 * 一轮核验是「每条断言一次检索 + 一次判定」，12 条就是二十几次上游调用。
 * 塞进搜索流会让首屏等它，而大多数人根本不会点这一下 —— 贵的事情必须由用户点出来。
 *
 * 为什么不用 /api/verify：那个接口核的是「一篇文章」（自己抽断言、自己分段），
 * 而这里核的是「搜索流水线已经抽好、并带 quote 的那批断言」。共用同一套 verify 内核，
 * 但入口不同 —— 把两者合并会让 /api/verify 的正文语义被污染。
 */
const perClient = createLimiter({
  name: "evidence",
  limit: readPositiveInt("PROBE_EVIDENCE_RATE_PER_MIN", 6),
});

/** 换 IP 就绕开 per-IP 额度，所以还有一道进程级总闸。 */
const globalLimiter = createLimiter({
  name: "evidence-global",
  limit: readPositiveInt("PROBE_GLOBAL_EVIDENCE_PER_MIN", 60),
});

/** 一次核验要串行打十几次上游，并发必须卡死；超了直接 503，不排队。 */
const gate = createGate(readPositiveInt("PROBE_EVIDENCE_CONCURRENCY", 2));

/** 40 条断言 × 每条几百字，128KB 足够。 */
const MAX_BODY_BYTES = 128_000;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

const Body = z.object({
  claims: z.array(ClaimSchema).min(1).max(40),
  /**
   * 本文自己引用过的来源。用于「自证不算票」：
   * 一篇稿子引用过的媒体再回来给它作证，吻合度会恒等于 1。
   */
  citedOwners: z.array(z.string().max(120)).max(40).default([]),
  /** 只用于日志与展示，不参与计算。 */
  query: z.string().max(200).optional(),
});

export async function POST(request: Request) {
  if (isCrossSite(request)) return json({ ok: false, error: "cross_site", message: "拒绝跨站调用。" }, 403);
  const auth = await requireUser(request);
  if (!auth.ok) return auth.response;

  const per = perClient.check(clientKey(request));
  if (!per.ok) {
    return rateLimited(per.retryAfterSeconds, "核验请求过于频繁，请 " + per.retryAfterSeconds + " 秒后重试。");
  }
  const all = globalLimiter.check("all");
  if (!all.ok) return json({ ok: false, error: "busy", message: "服务当前请求量过大，请稍后再试。" }, 503);

  const limited = await readJsonBody(request, MAX_BODY_BYTES);
  if (!limited.ok) return json({ ok: false, error: limited.code, message: limited.message }, limited.status);
  const parsed = Body.safeParse(limited.value);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return json(
      {
        ok: false,
        error: "invalid_body",
        message:
          "断言形状不对：" + (first ? first.path.join(".") + " " + first.message : "未知字段错误"),
      },
      422,
    );
  }

  const body = parsed.data;
  const release = gate.acquire();
  if (!release) return json({ ok: false, error: "busy", message: "已有一轮核验在跑，请稍后再试。" }, 503);

  const started = Date.now();
  try {
    /**
     * 闸门在检索之前先跑一遍（纯函数，不花一分钱）。
     * 即便下面因为「没有留出集检索器」当场返回，报出去的 kept/skipped 也是真的 ——
     * 拿 body.claims.length 充数会让界面显示「闸门跳过 N 条：缺数字/缺主体」，
     * 而那 N 条可能条条都合格。数字要对得上它自己的解释。
     */
    const gateRes = selectVerifiable(body.claims);
    const deps = makeHeldoutDeps({
      search: undefined,
      judge: llmJudge(),
      citedOwners: body.citedOwners,
    });
    // makeHeldoutDeps 里 search 为空会直接返回 null —— 那正好是「没有留出集检索器」。
    if (!deps) {
      const empty = buildDossier({ claims: [], verdicts: [], evidence: [], citedOwners: body.citedOwners });
      return json({
        ok: true,
        blocked: "no_heldout_retriever",
        message:
          "本机没有配置留出集检索（TAVILY_API_KEY 或设置里的检索 key），" +
          "所以这一轮找不到「本文没引用过的材料」。没有留出集就没有吻合度 —— 不给数字。",
        result: empty,
        gate: { kept: gateRes.kept.length, skipped: gateRes.skipped.length },
        // 过了闸门但没检索器 → 一条都没核；没过闸门的那些本来就不该核。
        notJudged: gateRes.kept.length,
        degraded: ["evidence:no_retriever"],
        elapsedMs: Date.now() - started,
      });
    }

    const res = await verifyClaims(body.claims, deps, { citedOwners: body.citedOwners });
    const picked = pickJudged(body.claims, res.verdicts);
    const result = buildDossier({
      claims: picked.claims,
      verdicts: picked.verdicts,
      // 证据的 authority 由结构判据决定（.gov/.edu/通讯社/自媒体），不每次拍数。
      evidence: res.evidence.map((e) => ({
        id: e.id,
        owner: e.owner,
        authority: authorityOf(e.owner).authority,
      })),
      citedOwners: body.citedOwners,
    });

    /**
     * 落一条校准样本：predicted 就是这一轮给出的吻合度。标签由用户在界面上点，
     * 记账失败不能毁掉核验结果 —— 少一条样本是遗憾，丢一次核验是事故。
     */
    const degraded = [...res.degraded, ...result.degraded];
    let sampleId: string | null = null;
    if (result.view.agreement && result.counts.judged > 0) {
      try {
        const sample = await recordSample({
          predicted: result.view.agreement.value,
          judged: result.counts.judged,
          nEff: result.view.nEff,
          contradicted: result.counts.contradicted,
          claims: body.claims.length,
        });
        sampleId = sample.id;
      } catch {
        degraded.push("calibration:record_failed");
      }
    }

    return json({
      ok: true,
      blocked: res.blocked,
      message: null,
      result,
      sampleId,
      gate: { kept: res.gate.kept, skipped: res.gate.skipped },
      notJudged: picked.notJudged,
      degraded,
      elapsedMs: Date.now() - started,
    });
  } catch (err) {
    return json(
      {
        ok: false,
        error: "internal",
        message: publicMessage(err, "核验过程中出错了，请稍后重试。"),
      },
      500,
    );
  } finally {
    release();
  }
}
