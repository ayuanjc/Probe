import { NextResponse } from "next/server";
import { snapshotMetrics } from "@/lib/metrics";

/**
 * 运行指标。默认脱敏：查询词是用户输入，这个端点又没有鉴权，
 * 一个能公开读到「谁搜了什么」的接口比没有这个接口更糟。
 * 想在本机看清查询词，就在环境里设 PROBE_METRICS_KEY，请求时带上同名头。
 *
 * 注意：数据只在内存里（本进程，环形 200 条）。多实例部署时每个实例各有一份，
 * 这不是聚合监控 —— 想长期看趋势要去接外部监控，而不是把这里做成数据库。
 */
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const key = process.env.PROBE_METRICS_KEY;
  const given = request.headers.get("x-probe-metrics-key");
  const revealQueries = Boolean(key) && given === key;

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