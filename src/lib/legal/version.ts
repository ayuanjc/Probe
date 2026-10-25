import { createHash } from "node:crypto";

import { CONSENT_MIN_READ_MS } from "../consent";
import { TERMS_CN } from "./terms-cn";
import { TERMS_EN } from "./terms-en";
import type { LegalDoc } from "./types";

/**
 * 协议版本号 = 正文的 SHA-256 前 12 位。
 *
 * 这样只有一件事能让版本号变：正文（中、英、日三份都算）或生效日期有一个字不一样。
 * 手写版本号的问题是它会忘 —— 忘了改，老用户带着上个月的 cookie 继续用，
 * 新条款对他们不生效，等于白写。算出来的版本号忘不了。
 *
 * 中文是准据文本，但英日译本也参与哈希：译本改了同样是内容变更，
 * 读英文/日文的用户有权被重新提示。
 *
 * 副作用要清楚：这 12 位是**内容的指纹**，不是保密值；它随正文变化，因此
 * 每次改字都必须重跑构建（服务端常量在 build 时算一次，页面 force-dynamic 只影响渲染）。
 */

/** 生效日期。改它同样是内容变更，会进哈希。 */
export const TERMS_EFFECTIVE = "2026-10-25";

function canonical(doc: LegalDoc): string {
  const lines: string[] = [doc.lang, doc.title, doc.intro];
  for (const section of doc.sections) {
    lines.push("## " + section.heading);
    for (const block of section.blocks) {
      if (block.kind === "list") {
        for (const item of block.items) lines.push("- " + item);
      } else {
        lines.push((block.kind === "callout" ? "! " : "> ") + block.text);
      }
    }
  }
  return lines.join("\n");
}

/**
 * 正文的稳定序列化，测试里也用它验证「改了字就换版本」。
 *
 * 用 options 而不是位置参数：三个译本 + 生效日期一共四样东西，位置参数一旦
 * 传错顺序（例如把日期塞进 ja 位）算出来的号照样是 12 位十六进制，看着一切正常，
 * 但版本号与正文脱钩了 —— 那种错误不会报错，只会静默失效。
 */
export function termsFingerprint(
  opts: {
    cn?: LegalDoc;
    en?: LegalDoc;
    ja?: LegalDoc;
    effective?: string;
  } = {},
): string {
  const cn = opts.cn ?? TERMS_CN;
  const en = opts.en ?? TERMS_EN;
  // 日文版暂未接入（正文已写好，见 terms-ja.ts，按用户要求先搁置）。
  // 一旦接入，它必须进入哈希 —— 译本改了同样是内容变更。
  const ja = opts.ja;
  const effective = opts.effective ?? TERMS_EFFECTIVE;

  const body = [
    "# effective " + effective,
    "",
    canonical(cn),
    "",
    "=== en ===",
    "",
    canonical(en),
    ja ? "\n=== ja ===\n\n" + canonical(ja) : "",
  ].join("\n");

  return createHash("sha256").update(body, "utf8").digest("hex");
}

export const TERMS_VERSION = termsFingerprint().slice(0, 12);

/** 弹层至少要停留多久（唯一定义在 consent.ts，那边客户端也要用）。 */
export { CONSENT_MIN_READ_MS };
