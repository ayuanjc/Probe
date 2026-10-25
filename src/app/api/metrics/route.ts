import { NextResponse } from "next/server";
import { snapshotMetrics } from "@/lib/metrics";
import { createLimiter, readPositiveInt } from "@/lib/rate-limit";
import { clientKey, constantTimeEqual } from "@/lib/request-guard";
import { requireUser } from "@/lib/auth/guard";

/**
 * 运行指标。默认脱敏：查询词是用户输入，即便这个端点要求登录，
 * 一个能读到「谁搜了什么」的接口也比没有这个接口更糟。
 * 想在本机看清查询词，就在环境里设 PROBE_METRICS_KEY，请求时带上 x-probe-metrics-key 头。
 *
 * 注意：数据只在内存里（本进程，环形 200 条）。多实例部署时每个实例各有一份，
 * 这不是聚合监控 —— 想长期看趋势要去接外部监控，而不是把这里做成数据库。
 */
export const dynamic = "force-dynamic";

const perClient = createLimiter({
  name: "metrics",
  limit: readPositiveInt("PROBE_METRICS_RATE_LIMIT_PER_MIN", 60),
});

export async function GET(request: Request) {
  const auth = await requireUser(request);
  if (!auth.ok) return auth.response;

  const rl = perClient.check(clientKey(request));
  if (!rl.ok) {
    return NextResponse.json(
      { ok: false, error: "rate_limited" },
      { status: 429, headers: { "cache-control": "no-store", "retry-after": String(rl.retryAfterSeconds) } },
    );
  }

  const key = process.env.PROBE_METRICS_KEY;
  const given = request.headers.get("x-probe-metrics-key");
  /**
   * 必须常量时间比较：`given === key` 会按第一个不同字节提前返回，
   * 攻击者能靠响应时间一个字节一个字节地把 key 试出来。
   */
  const revealQueries = Boolean(key) && constantTimeEqual(given, key);

  const snapshot = snapshotMetrics({ revealQueries });
  return NextResponse.json(
    {
      ...snapshot,
      /**
       * 把"为什么看不到查询词"直接写在响应里：前端不必自己猜规则，
       * 也不会有人以为是采集坏了。
       */
      redaction: {
        redacted: !revealQueries,
        keyConfigured: Boolean(key),
        hint: key
          ? "已配置 PROBE_METRICS_KEY：带上 x-probe-metrics-key 头即可看到查询词。"
          : "查询词已脱敏。设置 PROBE_METRICS_KEY 后在请求里带 x-probe-metrics-key 头可解除。",
      },
    },
    { headers: { "cache-control": "no-store" } },
  );
}
