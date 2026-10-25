import Link from "next/link";
import type { ReactNode } from "react";

/**
 * 法律页（隐私政策 / 用户协议）的外壳。
 *
 * 两份文档的结构完全一样：标题 + 生效日期 + 若干节 + 返回入口。
 * 抽一个壳出来，是为了让它们永远长得一样 —— 备案核验、网信抽查看的是
 * “这两页存在、内容对应、能互相跳转”，长得像两份野生 Markdown 反而显得敷衍。
 *
 * 排版刻意保守：正文 13px、行高 1.9、最大宽度 760px。太长的一行读起来
 * 像产品文案，法律文本要的是“可以逐行核对”。
 */
export function LegalShell({
  title,
  updated,
  intro,
  children,
}: {
  title: string;
  updated: string;
  intro?: ReactNode;
  children: ReactNode;
}) {
  return (
    <main className="safe-x mx-auto w-full max-w-[760px] py-12 sm:py-16">
      <header className="mb-8 border-b border-neutral-800 pb-5">
        <p className="font-mono text-[10px] text-neutral-600">探针 · Probe</p>
        <h1 className="mt-2 text-[22px] font-semibold leading-tight text-white">{title}</h1>
        <p className="mt-2 font-mono text-[10px] tabular-nums text-neutral-600">
          生效日期 {updated} · 最后更新 {updated}
        </p>
      </header>

      {intro && <div className="mb-8 text-[13px] leading-8 text-neutral-400">{intro}</div>}

      <div className="flex flex-col gap-7">{children}</div>

      <nav className="mt-12 flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-neutral-800 pt-5 font-mono text-[10px] text-neutral-600">
        <Link href="/" className="transition-colors hover:text-neutral-300">
          ← 返回首页
        </Link>
        <Link href="/privacy" className="transition-colors hover:text-neutral-300">
          隐私政策
        </Link>
        <Link href="/terms" className="transition-colors hover:text-neutral-300">
          用户协议
        </Link>
        <a
          href="https://beian.miit.gov.cn/"
          target="_blank"
          rel="noopener noreferrer"
          className="transition-colors hover:text-neutral-300"
        >
          工信部备案查询
        </a>
      </nav>
    </main>
  );
}

/** 一节：标题 + 正文。序号由调用方写进标题里，顺序变了要一起改。 */
export function LegalSection({ heading, children }: { heading: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-[14px] font-semibold text-neutral-100">{heading}</h2>
      <div className="flex flex-col gap-2 text-[13px] leading-8 text-neutral-400">{children}</div>
    </section>
  );
}

/** 条款列表。方形项目符，跟产品的「1px 边框 + 单色」一致，不用圆点。 */
export function LegalList({ items }: { items: ReactNode[] }) {
  return (
    <ul className="flex flex-col gap-1.5">
      {items.map((it, i) => (
        <li key={i} className="flex gap-2.5">
          <span aria-hidden className="mt-[13px] h-[3px] w-[3px] shrink-0 bg-neutral-600" />
          <span className="min-w-0">{it}</span>
        </li>
      ))}
    </ul>
  );
}
