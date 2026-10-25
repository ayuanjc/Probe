import type { Metadata } from "next";
import { redirect } from "next/navigation";
import ProbeLogo from "@/components/ProbeLogo";
import { SignupPanel } from "@/components/AuthPanels";
import WhatIsThis from "@/components/WhatIsThis";
import { pageUserOrNull } from "@/lib/auth/guard";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "邀请码注册" };

/** 邀请码注册页。没有邀请码这条路就走不通 —— 本站不开放自由注册。 */
export default async function SignupPage() {
  if (await pageUserOrNull()) redirect("/");

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-[420px] flex-col justify-center gap-6 px-5 py-10">
      <header className="flex flex-col items-center gap-3">
        <ProbeLogo size={26} />
        <p className="font-mono text-[11px] text-neutral-500">凭邀请码创建账号</p>
      </header>

      {/* 与登录页同一段说明：凭码注册的人同样需要知道自己注册的是什么。 */}
      <p className="-mb-1 text-center text-[12px] leading-relaxed text-neutral-400">
        一次提问，回一组<span className="text-neutral-200">可核验</span>的数据面板。
      </p>

      <div className="rounded-md border border-neutral-800 bg-[#0f0f0f] p-5">
        <h1 className="mb-4 text-[15px] font-semibold text-white">注册</h1>
        <SignupPanel />
      </div>

      <WhatIsThis />

      <p className="text-center font-mono text-[10px] leading-relaxed text-neutral-700">
        邀请码由管理员在后台生成，一次性或限次使用。
      </p>
    </main>
  );
}
