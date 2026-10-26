import Workspace from "@/components/Workspace";
import { requirePageUser } from "@/lib/auth/guard";
import { getTrending } from "@/lib/trending";
import { getHotLists } from "@/lib/hotlist";

/**
 * 查询走 ?q= 而非仅 POST：结果链接可分享、可刷新重放，
 * 也让 headless 截图 / 验收脚本能直接打到某个具体查询。
 *
 * 没有 query 时首屏给热榜 —— 一个只能搜的产品没有任何回访理由。
 */
export const dynamic = "force-dynamic";

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  // 页面级只是体验：真正拦住未授权访问的是 /api/* 里的 requireUser。
  await requirePageUser();
  const params = await searchParams;
  // 夹一下长度：/api/search 的上限是 400 字，这里不拦就等于让首屏自动跑一轮注定 400 的请求，
  // 用户看到的是「查询过长」而不是「你贴的东西太多了，前 400 字已在搜」。
  const query = (params.q ?? "").trim().slice(0, 400);
  /**
   * 两块并行取：热榜（HN + 基线）与国内榜单（百度/掘金）互不依赖，
   * 串行等于让首屏多等一次网络往返。国内榜单那侧自带 6s 超时与 15 分钟缓存，
   * 拿不到就返回空快照 —— 页面照常渲染，只是少一块。
   */
  const [trending, hot] = query
    ? [null, null]
    : await Promise.all([getTrending(), getHotLists()]);
  return <Workspace initialQuery={query} trending={trending} hot={hot} />;
}
