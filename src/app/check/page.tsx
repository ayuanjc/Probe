import type { Metadata } from "next";
import Link from "next/link";
import CheckPanel from "@/components/CheckPanel";

/**
 * 公开核验 /check：不用登录就能核一段话。
 *
 * 为什么值得开这个口子：核验是这站唯一「能当场自证」的功能 —— 陌生人不需要
 * 相信我们的面板，把一段他本来就不确定的话贴进来，看我们给出的三态与来源就行了。
 * 代价是钱（每次核验几十次上游调用），所以匿名侧有独立的每 IP / 每日上限。
 */
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "公开核验",
  description: "贴一段话，把它拆成可以被外部证实的断言逐条核对；不需要登录，不用邮箱。",
};

export default function CheckPage() {
  return (
    <main className="mx-auto w-full max-w-[760px] px-5 py-10">
      <nav className="mb-6 flex items-center gap-3 font-mono text-[11px] text-neutral-600">
        <Link href="/login" className="transition-colors hover:text-neutral-300">
          探针
        </Link>
        <span className="text-neutral-800">/</span>
        <span className="text-neutral-500">公开核验</span>
      </nav>

      <header className="mb-6">
        <h1 className="text-[26px] font-semibold tracking-tight text-white">公开核验</h1>
        <p className="mt-2 max-w-[640px] text-[13px] leading-relaxed text-neutral-400">
          贴一段你本来就拿不准的话。它会被拆成一句句可被外部证实的断言，
          逐条去外部材料里找支持或反证，然后如实告诉你：哪一条站得住、哪一条被谁反驳了、
          哪一条根本没人写过。
        </p>
        <p className="mt-2 max-w-[640px] font-mono text-[10px] leading-relaxed text-neutral-600">
          三态，不给真假判决。没有被反驳的断言，很可能只是没人写过它 —— 我们不会替你说成「查无此事」。
          独立来源少于 2 个时不给吻合度，写 N/A。
        </p>
      </header>

      <CheckPanel />

      <section className="mt-8 border-t border-neutral-900 pt-4">
        <h2 className="font-mono text-[10px] uppercase tracking-wider text-neutral-600">不登录能做什么</h2>
        <ul className="mt-2 flex flex-col gap-1.5 text-[12px] leading-relaxed text-neutral-500">
          <li>一段正文（120–2000 字），一次一条，每分钟 1 次、每天 40 次 —— 一次核验就要跑几十次上游调用。</li>
          <li>不落历史、不记账号、不需要邮箱；只按 IP 计数，用完等明天。</li>
          <li>不代抓链接：抓取目标由请求方指定，那等于开一个免费代理。</li>
          <li>
            登录后有完整版：4 万字长文、链接抓取、历史、导出，以及「关注实体」这类持续追踪。
            <Link href="/login" className="ml-1 text-blue-400 transition-colors hover:text-blue-300">
              去看看 →
            </Link>
          </li>
        </ul>
      </section>
    </main>
  );
}
