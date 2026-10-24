import Workspace from "@/components/Workspace";
import { requirePageUser } from "@/lib/auth/guard";
import { getTrending } from "@/lib/trending";

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
  const query = (params.q ?? "").trim();
  const trending = query ? null : await getTrending();
  return <Workspace initialQuery={query} trending={trending} />;
}
