import type { Metadata } from "next";
import Link from "next/link";
import AdminConsole from "@/components/AdminConsole";
import ProbeLogo from "@/components/ProbeLogo";
import { requirePageAdmin, sitePath } from "@/lib/auth/guard";

/**
 * 后台管理。整页在服务端就把 admin 校验做掉：
 * 非管理员连这段 HTML 都拿不到，不会出现"页面能打开、接口全 403"的半吊子状态。
 */
export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "后台管理" };

export default async function AdminPage() {
  const user = await requirePageAdmin();

  return (
    <main className="mx-auto flex w-full max-w-[1100px] flex-col gap-6 px-5 py-8 sm:px-8">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-neutral-800 pb-5">
        <Link href={sitePath("/")} className="flex items-center" aria-label="回到首页">
          <ProbeLogo size={22} />
        </Link>
        <nav className="flex items-center gap-4 font-mono text-[11px] text-neutral-500">
          <Link href={sitePath("/metrics")} className="transition-colors hover:text-white">
            指标
          </Link>
          <Link href={sitePath("/")} className="transition-colors hover:text-white">
            ← 返回终端
          </Link>
        </nav>
      </header>

      <div>
        <h1 className="text-lg font-semibold text-white">后台管理</h1>
        <p className="mt-1 max-w-[70ch] text-xs leading-relaxed text-neutral-500">
          邀请码是唯一的开户入口 —— 这里发码、停用、看谁用了几次。
          密码只以 scrypt 哈希存在 .data/auth/store.json 里，任何界面都不会显示明文（新建时那一次除外）。
        </p>
      </div>

      <AdminConsole me={{ id: user.id, username: user.username }} />
    </main>
  );
}
