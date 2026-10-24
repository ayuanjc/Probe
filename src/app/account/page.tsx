import type { Metadata } from "next";
import Link from "next/link";
import ProbeLogo from "@/components/ProbeLogo";
import { ChangePasswordPanel } from "@/components/AuthPanels";
import { requirePageUser, sitePath } from "@/lib/auth/guard";

/**
 * 个人页：目前只有改密码。
 * 首登被强制改密的用户（mustChangePassword）也会从这里走一次。
 */
export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "账号" };

export default async function AccountPage() {
  const user = await requirePageUser({ allowPendingPassword: true });

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-[460px] flex-col justify-center gap-6 px-5 py-10">
      <header className="flex flex-col items-center gap-3">
        <Link href={sitePath("/")} aria-label="回到首页">
          <ProbeLogo size={26} />
        </Link>
        <p className="font-mono text-[11px] text-neutral-500">
          {user.username}
          {user.role === "admin" && <span className="ml-1 text-blue-400">· 管理员</span>}
        </p>
      </header>

      <div className="rounded-md border border-neutral-800 bg-[#0f0f0f] p-5">
        <h1 className="mb-1 text-[15px] font-semibold text-white">修改密码</h1>
        {user.mustChangePassword ? (
          <p className="mb-4 text-[12px] leading-relaxed text-amber-400/90">
            这是管理员发的初始密码，先改掉再用。
          </p>
        ) : (
          <p className="mb-4 text-[12px] leading-relaxed text-neutral-500">
            密码只以 scrypt 哈希保存在服务器上。
          </p>
        )}
        <ChangePasswordPanel />
      </div>

      <nav className="text-center font-mono text-[11px] text-neutral-600">
        <Link href={sitePath("/")} className="transition-colors hover:text-white">
          ← 返回终端
        </Link>
      </nav>
    </main>
  );
}
