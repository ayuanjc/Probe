import Link from "next/link";

import type { LegalLang } from "@/lib/legal/types";

/**
 * 协议语言切换（中文准据文本 / English / 日本語）。
 *
 * 放在页面右上角而不是页尾：协议的第一件事是「我在读哪个版本、它算不算准」，
 * 这个判断必须在你开始读之前就能做。页尾只保留返回首页之类的出口。
 */

type Item = { lang: LegalLang; href: string; label: string; hint: string };

const ITEMS: Item[] = [
  { lang: "zh", href: "/terms", label: "中文", hint: "准据文本" },
  { lang: "en", href: "/terms/en", label: "English", hint: "official translation" },
];

export function LegalLangSwitch({ current }: { current: LegalLang }) {
  return (
    <nav className="flex shrink-0 items-center gap-1.5" aria-label="协议语言">
      {ITEMS.map((item) => {
        const active = item.lang === current;
        if (active) {
          return (
            <span
              key={item.lang}
              aria-current="true"
              title={item.hint}
              className="rounded border border-neutral-600 bg-neutral-800/60 px-2.5 py-1 font-mono text-[10px] text-neutral-100"
            >
              {item.label}
            </span>
          );
        }
        return (
          <Link
            key={item.lang}
            href={item.href}
            title={item.hint}
            className="rounded border border-neutral-800 px-2.5 py-1 font-mono text-[10px] text-neutral-400 transition-colors hover:border-neutral-600 hover:text-white"
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
