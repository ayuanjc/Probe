import type { ReactNode } from "react";

import { CONTACT_EMAIL, OPERATOR_NAME } from "./contact";
import type { LegalLang } from "./types";

/**
 * 协议正文的行内渲染：只认两种标记，**加粗** 与五个占位符。
 *
 * 单独拆出来的原因很实际：这段逻辑最容易被测到、也最容易出丑。占位符没替换成功，
 * 页面上就直接印出「停留满 {readSeconds} 秒」—— 一份法律文件里露出花括号，
 * 比排错版还难看，而且会被当成「这页根本没做完」。拆出来之后测试可以只依赖
 * 这个文件（不含 next/link、不含页面壳），用最便宜的断言把这类事故钉死。
 *
 * 加粗段落里允许再出现占位符（中文第三节就是「停留满 {readSeconds} 秒」整句加粗），
 * 所以 bold 分支必须递归，不能直接切字符串。
 */

const CONTACT = CONTACT_EMAIL;
const OPERATOR = OPERATOR_NAME;

export type LegalContext = {
  version: string;
  effective: string;
  readSeconds: number;
};

export function operatorName(lang: LegalLang): string {
  if (OPERATOR) return OPERATOR;
  if (lang === "zh") return "本服务的运营者";
  if (lang === "ja") return "本サービスの運営者";
  return "the operator of the Service";
}

function contactNode(lang: LegalLang): ReactNode {
  if (CONTACT) {
    return (
      <a className="text-blue-500 hover:underline" href={"mailto:" + CONTACT}>
        {CONTACT}
      </a>
    );
  }
  return (
    <span className="text-neutral-500">
      {lang === "zh"
        ? "运营者邮箱（部署方未配置 PROBE_CONTACT_EMAIL）"
        : lang === "ja"
          ? "運営者の連絡先（PROBE_CONTACT_EMAIL が未設定）"
          : "the operator's address (PROBE_CONTACT_EMAIL is not configured)"}
    </span>
  );
}

/** 行内标记：**加粗** 与五个占位符。其余字原样输出。 */
const INLINE = /(\*\*[^*]+\*\*|\{operator\}|\{contact\}|\{readSeconds\}|\{version\}|\{effective\})/g;

/** 正文里认得的全部占位符，测试用它守「没有第六种」。 */
export const PLACEHOLDERS = ["{operator}", "{contact}", "{readSeconds}", "{version}", "{effective}"] as const;

export function renderInline(text: string, ctx: LegalContext, lang: LegalLang): ReactNode[] {
  const parts = text.split(INLINE);
  return parts.map((part, i) => {
    if (!part) return null;
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4) {
      // 加粗段落里也可能有占位符，必须递归 —— 直接 slice 会在页面上印出花括号原文。
      return (
        <strong key={i} className="font-normal text-neutral-200">
          {renderInline(part.slice(2, -2), ctx, lang)}
        </strong>
      );
    }
    switch (part) {
      case "{operator}":
        return <span key={i}>{operatorName(lang)}</span>;
      case "{contact}":
        return <span key={i}>{contactNode(lang)}</span>;
      case "{readSeconds}":
        return <span key={i}>{ctx.readSeconds}</span>;
      case "{version}":
        return (
          <span key={i} className="font-mono text-[12px] text-neutral-300">
            {ctx.version}
          </span>
        );
      case "{effective}":
        return <span key={i}>{ctx.effective}</span>;
      default:
        return <span key={i}>{part}</span>;
    }
  });
}
