import { NextResponse } from "next/server";
import { ensureHistory } from "@/lib/heat-history";
import { getTrending } from "@/lib/trending";
import { createLimiter, readPositiveInt } from "@/lib/rate-limit";
import { clientKey, constantTimeEqual, publicMessage } from "@/lib/request-guard";
import { historyEnabled, pruneExpired } from "@/lib/history-store";

/**
 * 后台热点计算（PRD Phase 3 第 1 项）。
 *
 * 存在的理由：热度状态标签依赖 30 天历史基线，而基线的构建要 60 次 HN 请求。
 * 让"第一个访客"来承担这件事，等于让踩进来的人等 20 秒，而且 cold start 后
 * 每个实例都会各跑一遍。改成外部定时器（Vercel Cron / GitHub Actions / cron）
 * 定期打这个端点，基线就一直在、快照也一直是热的。
 *
 * 刻意不开放：没有 PROBE_CRON_SECRET 时直接 503，而不是"先开着等以后再说"。
 * 一个无鉴权的端点能触发 60 次外部请求，被扫到就是免费的放大镜。
 */
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * 秘密尝试次数限制：常量时间比较能防时序侧信道，
 * 但挡不住「一秒一百次把 32 位 hex 撞出来」之外的成本问题 ——
 * 这个端点每通过一次就要打 60 个外部请求，先限速再谈其他。
 */
const attempts = createLimiter({
  name: "cron",
  limit: readPositiveInt("PROBE_CRON_RATE_LIMIT_PER_MIN", 10),
});

/** 太短的 secret 等于没有 secret，直接拒绝启动这个端点。 */
const MIN_SECRET_LEN = 16;

function authorized(request: Request): { ok: boolean; reason?: string; disabled?: boolean } {
  const secret = process.env.PROBE_CRON_SECRET;
  if (!secret) {
    return { ok: false, disabled: true, reason: "未配置 PROBE_CRON_SECRET：Cron 端点保持关闭。" };
  }
  if (secret.length < MIN_SECRET_LEN) {
    return {
      ok: false,
      disabled: true,
      reason: `PROBE_CRON_SECRET 太短（至少 ${MIN_SECRET_LEN} 位）。请换成 openssl rand -hex 32 的输出。`,
    };
  }
  const auth = request.headers.get("authorization");
  const direct = request.headers.get("x-probe-cron-secret");
  const bearer = auth && auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : null;
  // 常量时间比较：=== 会按第一个不同字节提前返回，时序上可逐字节试探。
  if (constantTimeEqual(bearer, secret) || constantTimeEqual(direct, secret)) return { ok: true };
  return { ok: false, reason: "密钥不匹配。" };
}

async function run(request: Request) {
  const guard = attempts.check(clientKey(request));
  if (!guard.ok) {
    return NextResponse.json(
      { ok: false, error: "rate_limited", message: "尝试过于频繁，请稍后再试。" },
      { status: 429, headers: { "cache-control": "no-store", "retry-after": String(guard.retryAfterSeconds) } },
    );
  }

  const gate = authorized(request);
  if (!gate.ok) {
    return NextResponse.json(
      { ok: false, error: gate.disabled ? "cron_disabled" : "forbidden", message: gate.reason },
      { status: gate.disabled ? 503 : 401 },
    );
  }

  const started = Date.now();
  try {
    // 先把基线补齐（落后时才真的去抓），再强制重算一次快照。
    const history = await ensureHistory();
    const snapshot = await getTrending(true);
    // 顺手清理过期的账号级历史：这件事没有任何时效性要求，
    // 但必须有个东西固定去做 —— 挂在已有的定时任务上比再起一个 timer 省事也省故障面。
    // 失败只记日志：清不掉旧记录是小事，让热点计算整体失败是大事。
    let pruned = 0;
    if (historyEnabled()) {
      try {
        pruned = pruneExpired();
      } catch (err) {
        console.warn("[history] 过期清理失败：" + (err instanceof Error ? err.message : String(err)));
      }
    }
    return NextResponse.json(
      {
        ok: true,
        elapsedMs: Date.now() - started,
        history: {
          days: history.history?.days.length ?? 0,
          from: history.history?.from ?? null,
          to: history.history?.to ?? null,
          pending: history.pending,
          reason: history.reason ?? null,
        },
        historyPruned: pruned,
        trending: {
          topics: snapshot.topics.length,
          considered: snapshot.consideredStories,
          fetched: snapshot.fetchedStories,
          degraded: snapshot.degraded,
          withStatus: snapshot.topics.filter((t) => Boolean(t.status)).length,
        },
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (err) {
    // 已鉴权的调用方也只看公共文案：响应里不该出现上游地址与内部状态。
    return NextResponse.json(
      { ok: false, error: "cron_failed", message: publicMessage(err, "热点计算失败，详见服务端日志。") },
      { status: 500, headers: { "cache-control": "no-store" } },
    );
  }
}

export async function GET(request: Request) {
  return run(request);
}

/** 有些定时器只发 POST。 */
export async function POST(request: Request) {
  return run(request);
}
