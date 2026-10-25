/**
 * 法律文档的数据形状。
 *
 * 为什么把协议写成数据而不是 JSX：同意弹层的版本号是**协议正文的哈希**。
 * 只要正文是手写 JSX，「哈希算的东西」和「用户实际看到的字」就会有两条来源，
 * 迟早出现「正文改了、哈希没变」——那正是让旧同意继续生效的那类事故。
 */

export type LegalBlock =
  | { kind: "p"; text: string }
  /** 显著提示段：整段加粗，用于免责、责任限制这类格式条款（《民法典》第 496 条的提示义务）。 */
  | { kind: "callout"; text: string }
  | { kind: "list"; items: string[] };

export type LegalSection = {
  heading: string;
  blocks: LegalBlock[];
};

/**
 * 语言。zh 是准据文本，en / ja 是正式译本（见第十七节的「以中文为准」）。
 * 日文不是顺手加的：日本用户落在《消費者契約法》的消费者合同规则下，
 * 用英文协议去覆盖日本消费者，条款解释上站不住。
 */
export type LegalLang = "zh" | "en" | "ja";

export type LegalDoc = {
  lang: LegalLang;
  title: string;
  intro: string;
  sections: LegalSection[];
};