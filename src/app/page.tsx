import Workspace from "@/components/Workspace";

/**
 * 查询走 ?q= 而非仅 POST：结果链接可分享、可刷新重放，
 * 也让 headless 截图 / 验收脚本能直接打到某个具体查询。
 */
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const params = await searchParams;
  return <Workspace initialQuery={params.q ?? ""} />;
}
