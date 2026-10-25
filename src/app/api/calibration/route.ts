import { z } from "zod";
import { calibrationSnapshot, labelSample } from "@/lib/calibration-store";
import { createLimiter, readPositiveInt } from "@/lib/rate-limit";
import { clientKey, isCrossSite, publicMessage, rateLimited, readJsonBody } from "@/lib/request-guard";
import { requireUser } from "@/lib/auth/guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 校准样本的两个动作。
 *
 * GET  读：ECE / MCE / Brier + 建议（ok / warn / bad / unknown）+ 已标注条数。
 * POST 标：给某一条样本记「结论成立 / 不成立」。
 *
 * 为什么没有「写预测」的入口：预测只能来自服务端那次真实核验（/api/evidence）。
 * 允许客户端上传 predicted 的话，任何人都能喂一批 (1.0, 对) 把 ECE 压到 0，
 * 于是这个数字就只剩装饰作用。
 */

const perClient = createLimiter({
  name: "calibration",
  limit: readPositiveInt("PROBE_CALIBRATION_RATE_PER_MIN", 30),
});

const MAX_BODY_BYTES = 8_000;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

const Body = z.object({
  id: z.string().min(1).max(120),
  /** true = 这一轮结论成立；false = 不成立。没有「不确定」——不确定就别点。 */
  correct: z.boolean(),
});

/** 通过闸门时把用户带出来 —— 贴标签要按人判归属，只判「登录了没」不够。 */
async function guard(request: Request): Promise<{ denied: Response } | { user: { id: string; admin: boolean } }> {
  if (isCrossSite(request)) {
    return { denied: json({ ok: false, error: "cross_site", message: "拒绝跨站调用。" }, 403) };
  }
  const auth = await requireUser(request);
  if (!auth.ok) return { denied: auth.response };
  const per = perClient.check(clientKey(request));
  if (!per.ok) {
    return {
      denied: rateLimited(per.retryAfterSeconds, "请求过于频繁，请 " + per.retryAfterSeconds + " 秒后再试。"),
    };
  }
  return { user: { id: auth.user.id, admin: auth.user.role === "admin" } };
}

export async function GET(request: Request) {
  const gated = await guard(request);
  if ("denied" in gated) return gated.denied;
  try {
    const snapshot = await calibrationSnapshot();
    /**
     * recent 里带着样本 id，而 id 现在是「贴标签的凭据」。
     * 不是自己的样本，别把 id 交出去 —— 归属校验已经拦得住，但没理由先递刀。
     * by 字段同样不下发：谁核验了什么不需要互相知道。
     */
    const recent = snapshot.recent.map((s) => ({
      ...s,
      by: undefined,
      id: s.by === gated.user.id || gated.user.admin ? s.id : "",
    }));
    return json({ ok: true, snapshot: { ...snapshot, recent } });
  } catch (err) {
    return json({ ok: false, error: "internal", message: publicMessage(err, "读取校准样本失败。") }, 500);
  }
}

export async function POST(request: Request) {
  const gated = await guard(request);
  if ("denied" in gated) return gated.denied;

  const limited = await readJsonBody(request, MAX_BODY_BYTES);
  if (!limited.ok) {
    return json({ ok: false, error: limited.code, message: limited.message }, limited.status);
  }
  const parsed = Body.safeParse(limited.value);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return json(
      {
        ok: false,
        error: "invalid_body",
        message:
          "标记得带样本 id 与对错：" + (first ? first.path.join(".") + " " + first.message : "未知字段错误"),
      },
      422,
    );
  }

  try {
    const res = await labelSample(parsed.data.id, parsed.data.correct, gated.user);
    if (!res.ok) {
      /**
       * 「不是你的样本」与「样本没了」必须回不同的话：
       * 前者是权限问题（换个人、或者去标自己那一轮），后者是时序问题（重跑一次）。
       * 统一回 404 会让人一直重试。
       */
      if (res.denied) {
        return json(
          {
            ok: false,
            error: "not_your_sample",
            message: "这条样本不是你那一轮核验产生的，只有它的发起人（或管理员）能贴标记。",
          },
          403,
        );
      }
      return json(
        {
          ok: false,
          error: "sample_not_found",
          message: "这条样本找不到了（可能被样本上限挤掉）。下一次核验会重新落一条。",
        },
        404,
      );
    }
    return json({ ok: true, sample: res.sample });
  } catch (err) {
    return json({ ok: false, error: "internal", message: publicMessage(err, "记录标记失败。") }, 500);
  }
}
