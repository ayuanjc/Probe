import { NextResponse } from "next/server";
import { ensureHistory } from "@/lib/heat-history";
import { getTrending } from "@/lib/trending";

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

function authorized(request: Request): { ok: boolean; reason?: string } {
  const secret = process.env.PROBE_CRON_SECRET;
  if (!secret) return { ok: false, reason: "未配置 PROBE_CRON_SECRET：Cron 端点保持关闭。" };
  const auth = request.headers.get("authorization");
  const direct = request.headers.get("x-probe-cron-secret");
  const bearer = auth && auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : null;
  if (bearer === secret || direct === secret) return { ok: true };
  return { ok: false, reason: "密钥不匹配。" };
}

async function run(request: Request) {
  const gate = authorized(request);
  if (!gate.ok) {
    const missing = !process.env.PROBE_CRON_SECRET;
    return NextResponse.json({ ok: false, error: missing ? "cron_disabled" : "forbidden", message: gate.reason }, { status: missing ? 503 : 401 });
  }

  const started = Date.now();
  try {
    // 先把基线补齐（落后时才真的去抓），再强制重算一次快照。
    const history = await ensureHistory();
    const snapshot = await getTrending(true);
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
    return NextResponse.json(
      { ok: false, error: "cron_failed", message: err instanceof Error ? err.message : String(err) },
      { status: 500 },
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