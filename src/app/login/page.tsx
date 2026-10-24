import type { Metadata } from "next";
import { redirect } from "next/navigation";
import ProbeLogo from "@/components/ProbeLogo";
import { LoginPanel } from "@/components/AuthPanels";
import { pageUserOrNull } from "@/lib/auth/guard";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "登录" };

/**
 * 登录页。已经登录的人不该看到它 —— 直接送回首页，
 * 免得出现"我明明登录了，怎么又回到登录框"的困惑。
 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  if (await pageUserOrNull()) redirect("/");

  const params = await searchParams;
  const raw = typeof params.next === "string" ? params.next : "";
  // 只接受站内绝对路径：`//evil.com` 是协议相对 URL，会被浏览器当成外站跳转。
  const nextPath = raw.startsWith("/") && !raw.startsWith("//") ? raw.slice(0, 300) : "";

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-[420px] flex-col justify-center gap-6 px-5 py-10">
      <header className="flex flex-col items-center gap-3">
        <ProbeLogo size={26} />
        <p className="font-mono text-[11px] text-neutral-500">仅限受邀用户使用</p>
      </header>

      <div className="rounded-md border border-neutral-800 bg-[#0f0f0f] p-5">
        <h1 className="mb-4 text-[15px] font-semibold text-white">登录</h1>
        <LoginPanel nextPath={nextPath} />
      </div>

      <p className="text-center font-mono text-[10px] leading-relaxed text-neutral-700">
        本站是测试实例，账号由管理员发放。
        <br />
        忘记密码请让管理员重置。
      </p>
    </main>
  );
}
