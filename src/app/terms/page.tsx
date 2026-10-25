import type { Metadata } from "next";
import Link from "next/link";

import { LegalDocView } from "@/lib/legal/render";
import { TERMS_CN } from "@/lib/legal/terms-cn";
import { CONSENT_MIN_READ_MS, TERMS_EFFECTIVE, TERMS_VERSION } from "@/lib/legal/version";

/**
 * 这两页必须每次现算：备案号与联系邮箱来自部署时的环境变量。
 * 静态预渲染会在 \`next build\` 那一刻把它们烤死，运维改完 .env.local 重启后
 * 页面还是旧号 —— 这种「改了没生效」在合规检查里最致命。
 *
 * 正文不在这个文件里，在 \`src/lib/legal/terms-cn.ts\`：版本号是正文的哈希，
 * 正文与哈希必须是同一份数据，改字的地方只有一个。
 */
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "用户协议",
  description:
    "使用探针前请阅读：服务性质与能力边界、AI 生成内容的核对义务、禁止用途、责任限制与赔偿、中国内地 / 美国 / 新加坡三地的争议解决安排，以及对应的法律依据。",
};

const READ_SECONDS = Math.round(CONSENT_MIN_READ_MS / 1000);

export default function TermsPage() {
  const ctx = { version: TERMS_VERSION, effective: TERMS_EFFECTIVE, readSeconds: READ_SECONDS };

  return (
    <LegalDocView
      doc={TERMS_CN}
      ctx={ctx}
      meta={
        <>
          生效日期 {ctx.effective} · 版本{" "}
          <span className="font-mono text-neutral-500">{ctx.version}</span>（正文哈希）
        </>
      }
      actions={
        <Link
          href="/terms/en"
          className="shrink-0 rounded border border-neutral-700 px-2.5 py-1 font-mono text-[10px] text-neutral-300 transition-colors hover:border-neutral-500 hover:text-white"
        >
          English
        </Link>
      }
    />
  );
}
