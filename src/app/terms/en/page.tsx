import type { Metadata } from "next";
import Link from "next/link";

import { LegalDocView } from "@/lib/legal/render";
import { TERMS_EN } from "@/lib/legal/terms-en";
import { CONSENT_MIN_READ_MS, TERMS_EFFECTIVE, TERMS_VERSION } from "@/lib/legal/version";

/**
 * Terms of Service — English.
 *
 * Rendered from the same data pipeline as the Chinese page: one renderer, one hash,
 * one parsing rule for placeholders and bold. If the English text is edited, the
 * shared fingerprint changes too, so the consent gate asks the user to confirm again —
 * which is correct, because they assented to a specific body of text.
 *
 * The Chinese text is controlling; that statement lives in Section XVII of both
 * documents and is repeated in the header note below, because a translation that
 * silently claims equal authority is a gift to opposing counsel.
 */
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Terms of Service",
  description:
    "Terms of Service for Probe: service scope and limits, your duty to verify AI-generated output, prohibited uses, limitation of liability and indemnity, and the dispute-resolution arrangements for users in mainland China, the United States and Singapore, with statutory references.",
};

const READ_SECONDS = Math.round(CONSENT_MIN_READ_MS / 1000);

export default function TermsEnPage() {
  const ctx = { version: TERMS_VERSION, effective: TERMS_EFFECTIVE, readSeconds: READ_SECONDS };

  return (
    <LegalDocView
      doc={TERMS_EN}
      ctx={ctx}
      brand="Probe"
      meta={
        <>
          Effective {ctx.effective} · Version{" "}
          <span className="font-mono text-neutral-500">{ctx.version}</span> (hash of the body text)
          ; the Chinese version controls
        </>
      }
      actions={
        <Link
          href="/terms"
          className="shrink-0 rounded border border-neutral-700 px-2.5 py-1 font-mono text-[10px] text-neutral-300 transition-colors hover:border-neutral-500 hover:text-white"
        >
          中文
        </Link>
      }
      nav={
        <nav className="mt-12 flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-neutral-800 pt-5 font-mono text-[10px] text-neutral-600">
          <Link href="/terms" className="transition-colors hover:text-neutral-300">
            ← 中文版（准据文本）
          </Link>
          <Link href="/privacy" className="transition-colors hover:text-neutral-300">
            隐私政策
          </Link>
          <Link href="/" className="transition-colors hover:text-neutral-300">
            返回首页
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
      }
    />
  );
}