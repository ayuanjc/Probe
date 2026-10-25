import { prepareRuntimeConfig, regionSummary, withRuntimeConfig } from "@/lib/runtime-config";

/**
 * 设置面板里的「当前区域」。
 *
 * 为什么要一个接口而不是在渲染时算：区域取决于**来访 IP 与网关头**，那是请求级信息，
 * 页面可以是静态的、缓存的，这个结论不能。所以做成一次按需拉取（打开设置时才请求）。
 *
 * 这里不打任何上游、不读 key 的值，只回「用哪套规则、模型端点会被换成谁、允许哪些检索源」。
 */
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const cfg = await prepareRuntimeConfig(request);
  const summary = await withRuntimeConfig(cfg, () => regionSummary());
  return Response.json(summary, { headers: { "cache-control": "no-store" } });
}
