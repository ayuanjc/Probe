import { z } from "zod";
import { ClaimSchema, ClaimVerdictSchema } from "@/lib/schemas";
import { buildDossier } from "@/lib/dossier";
import { createLimiter, readPositiveInt } from "@/lib/rate-limit";
import {
  clientKey,
  isCrossSite,
  methodNotAllowed,
  readJsonBody,
} from "@/lib/request-guard";
import { requireUser } from "@/lib/auth/guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 文档级吻合度组装接口。
 *
 * 它不做检索、不调模型：断言、判定、留出集证据三样都由调用方带进来，这里只负责
 * 「谁有资格投票 / 谁进分母 / 谁被降级」和记账。这样它可以被 curl 直接验，
 * 也可以在流水线里当纯函数用 —— 一个会自己上网的接口是没法被单测钉死的。
 */
const perClient = createLimiter({
  name: "dossier",
  limit: readPositiveInt("PROBE_DOSSIER_RATE_LIMIT_PER_MIN", 20),
});

/** 纯计算也要有总闸：这个接口吃的是 CPU，被打满一样拖垮整站。 */
const globalLimiter = createLimiter({
  name: "dossier-global",
  limit: readPositiveInt("PROBE_GLOBAL_DOSSIER_PER_MIN", 240),
});

/** 400 条证据 + 80 条判定的上限，256KB 足够。 */
const MAX_BODY_BYTES = 256_000;
/**
 * 只有 POST：GET 是纯读取语义，最容易被直接敲进地址栏或被脚本 `curl` 一下。
 * 交给 Next 兜底会得到「405 + 空 body」，那是唯一一种前端没法展示的失败形态，
 * 所以这里自己回一个说明白了的 405。
 */
export const GET = () =>
  methodNotAllowed(["POST"], "文档核验结果要用 POST 提交（需要带 claims 与 verdicts）。");


function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

/**
 * 请求体一律当不可信输入：条数、字符串长度、authority 范围全部在这里收紧。
 * 断言与判定沿用 schemas 里的定义，避免出现「接口收的形状和流水线产出的形状不一样」。
 */
const Body = z.object({
  claims: z.array(ClaimSchema).max(40),
  verdicts: z.array(ClaimVerdictSchema).max(80).default([]),
  evidence: z
    .array(
      z.object({
        id: z.string().min(1).max(120),
        owner: z.string().min(1).max(120),
        authority: z.number().min(0).max(1).optional(),
      }),
    )
    .max(400)
    .default([]),
  citedOwners: z.array(z.string().max(120)).max(200).default([]),
  nEff: z.number().min(0).max(100).optional(),
  demo: z.boolean().optional(),
});

export async function POST(request: Request) {
  if (isCrossSite(request)) return json({ ok: false, error: "cross_site", message: "拒绝跨站调用。" }, 403);
  const auth = await requireUser(request);
  if (!auth.ok) return auth.response;

  const per = perClient.check(clientKey(request));
  if (!per.ok) {
    return new Response(
      JSON.stringify({
        ok: false,
        error: "rate_limited",
        message: `组装请求过于频繁，请 ${per.retryAfterSeconds} 秒后重试。`,
      }),
      {
        status: 429,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
          "retry-after": String(per.retryAfterSeconds),
        },
      },
    );
  }
  const all = globalLimiter.check("all");
  if (!all.ok) return json({ ok: false, error: "busy", message: "服务当前请求量过大，请稍后再试。" }, 503);

  const limited = await readJsonBody(request, MAX_BODY_BYTES);
  if (!limited.ok) return json({ ok: false, error: limited.code, message: limited.message }, limited.status);
  const raw = limited.value;

  const parsed = Body.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return json(
      {
        ok: false,
        error: "invalid_body",
        message:
          "断言 / 判定形状不对：" +
          (first ? first.path.join(".") + " " + first.message : "未知字段错误"),
      },
      422,
    );
  }

  const body = parsed.data;
  if (body.claims.length === 0) {
    return json({ ok: false, error: "no_claims", message: "没有断言可组装：先抽取一轮断言。" }, 422);
  }

  const result = buildDossier({
    claims: body.claims,
    verdicts: body.verdicts,
    evidence: body.evidence,
    citedOwners: body.citedOwners,
    nEff: body.nEff,
    demo: body.demo,
  });

  return json({ ok: true, result });
}
