import { prepareRuntimeConfig, regionSummary, withRuntimeConfig } from "@/lib/runtime-config";
import { createLimiter, readPositiveInt } from "@/lib/rate-limit";
import { clientKey } from "@/lib/request-guard";

/**
 * 设置面板里的「当前区域」。
 *
 * 为什么要一个接口而不是在渲染时算：区域取决于**来访 IP 与网关头**，那是请求级信息，
 * 页面可以是静态的、缓存的，这个结论不能。所以做成一次按需拉取（打开设置时才请求）。
 *
 * 这里不打任何上游、不读 key 的值，只回「用哪套规则、模型端点会被换成谁、允许哪些检索源」。
 */
export const dynamic = "force-dynamic";

/**
 * 这条不要求登录：它要在登录前也能判断「你现在被当成哪一侧」。
 * 但正因为不登录，就得有人守着请求量 —— 返回值里带着模型端点与可用检索源，
 * 等于一份部署指纹，免费无限次拉取毫无意义。
 */
const perClient = createLimiter({
  name: "region",
  limit: readPositiveInt("PROBE_REGION_RATE_PER_MIN", 60),
});

export async function GET(request: Request) {
  const per = perClient.check(clientKey(request));
  if (!per.ok) {
    return Response.json(
      { ok: false, error: "rate_limited", message: "请求太频繁，请稍后再试。" },
      { status: 429, headers: { "cache-control": "no-store", "retry-after": String(per.retryAfterSeconds) } },
    );
  }
  const cfg = await prepareRuntimeConfig(request);
  const summary = await withRuntimeConfig(cfg, () => regionSummary());
  return Response.json(summary, { headers: { "cache-control": "no-store" } });
}
