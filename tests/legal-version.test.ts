import test from "node:test";
import assert from "node:assert/strict";

import { TERMS_CN } from "../src/lib/legal/terms-cn";
import { TERMS_EN } from "../src/lib/legal/terms-en";
import { CONSENT_MIN_READ_MS, TERMS_EFFECTIVE, TERMS_VERSION, termsFingerprint } from "../src/lib/legal/version";
import type { LegalDoc } from "../src/lib/legal/types";
import { renderInline } from "../src/lib/legal/inline";

/**
 * 版本号来自正文哈希，这份测试守的是**它真的会变、也真的不会乱变**。
 *
 * 「会变」：改一个字（中文、英文、生效日期都算）版本号必须不同 —— 否则改完免责条款，
 *          老用户带着旧 cookie 继续用，新条款对他们形同虚设。
 * 「不乱变」：同一份正文每次算出来必须一样 —— 否则每次构建都换版本号，
 *          所有用户每次部署都被要求重新确认，最后没人会认真读。
 *
 * 另外守两条排版级事实：占位符只有白名单里那五个（写错一个字母就会在页面上原样露出
 * 花括号），加粗标记必须成对（落单的 ** 会吞掉后面半段正文）。
 */

const PLACEHOLDERS = new Set(["{operator}", "{contact}", "{readSeconds}", "{version}", "{effective}"]);

function clone(doc: LegalDoc): LegalDoc {
  return JSON.parse(JSON.stringify(doc)) as LegalDoc;
}

function allStrings(doc: LegalDoc): string[] {
  const out: string[] = [doc.title, doc.intro];
  for (const section of doc.sections) {
    out.push(section.heading);
    for (const block of section.blocks) {
      if (block.kind === "list") out.push(...block.items);
      else out.push(block.text);
    }
  }
  return out;
}

test("版本号是正文哈希的前 12 位十六进制，且与 termsFingerprint 一致", () => {
  assert.match(TERMS_VERSION, /^[0-9a-f]{12}$/);
  assert.equal(TERMS_VERSION, termsFingerprint().slice(0, 12));
  assert.equal(TERMS_VERSION.length, 12);
});

test("同一份正文算两次得到同一个版本号（构建不会每次都换号）", () => {
  assert.equal(termsFingerprint(), termsFingerprint());
});

test("中文正文改一个字，版本号就变", () => {
  const edited = clone(TERMS_CN);
  edited.sections[11].blocks[0] = {
    kind: "callout",
    text: (edited.sections[11].blocks[0] as { text: string }).text + "。",
  };
  assert.notEqual(termsFingerprint({ cn: edited }).slice(0, 12), TERMS_VERSION);
});

test("英文正文改一个字，版本号也变（英文是正式译本，同样算内容变更）", () => {
  const edited = clone(TERMS_EN);
  edited.intro = edited.intro.replace("govern your use", "govern your usage of");
  assert.notEqual(edited.intro, TERMS_EN.intro, "改动必须真的落进文本里");
  assert.notEqual(termsFingerprint({ en: edited }).slice(0, 12), TERMS_VERSION);
});

test("改生效日期同样是内容变更", () => {
  assert.notEqual(termsFingerprint({ effective: "2099-01-01" }).slice(0, 12), TERMS_VERSION);
  assert.equal(TERMS_EFFECTIVE, "2026-10-25");
});

test("占位符只有白名单里的五个，写错就会在页面上露出花括号", () => {
  for (const doc of [TERMS_CN, TERMS_EN]) {
    for (const text of allStrings(doc)) {
      const found = text.match(/\{[^}]*\}/g) ?? [];
      for (const token of found) {
        assert.ok(PLACEHOLDERS.has(token), "未知占位符 " + token + "（语言 " + doc.lang + "）");
      }
      // 反过来：不能有落单的花括号（{ 或 } 单独出现）
      const opens = (text.match(/\{/g) ?? []).length;
      const closes = (text.match(/\}/g) ?? []).length;
      assert.equal(opens, closes, "花括号不配对：" + text.slice(0, 40));
      assert.equal(opens, found.length, "存在空的或嵌套的花括号：" + text.slice(0, 40));
    }
  }
});

test("加粗标记必须成对出现", () => {
  for (const doc of [TERMS_CN, TERMS_EN]) {
    for (const text of allStrings(doc)) {
      const marks = (text.match(/\*\*/g) ?? []).length;
      assert.equal(marks % 2, 0, "落单的 ** 会吞掉后半段正文：" + text.slice(0, 60));
    }
  }
});

test("中英两份文档结构对得上（节数相同，每节都有内容）", () => {
  assert.equal(TERMS_CN.sections.length, TERMS_EN.sections.length);
  for (const doc of [TERMS_CN, TERMS_EN]) {
    for (const section of doc.sections) {
      assert.ok(section.heading.length > 0);
      assert.ok(section.blocks.length > 0, "空节：" + section.heading);
    }
  }
});

test("三地争议解决与关键法律依据都写在正文里，不是只写在注释里", () => {
  const cn = allStrings(TERMS_CN).join("\n");
  const en = allStrings(TERMS_EN).join("\n");
  for (const needle of ["FCRA", "DMCA", "JAMS", "SIAC", "民法典", "个人信息保护法", "UCTA", "CPFTA"]) {
    assert.ok(cn.includes(needle), "中文正文缺少 " + needle);
  }
  for (const needle of ["FCRA", "DMCA", "JAMS", "SIAC", "Civil Code", "Personal Information Protection Law", "UCTA", "CPFTA"]) {
    assert.ok(en.includes(needle), "英文正文缺少 " + needle);
  }
  // 中文是准据文本这件事必须写在正文里，不能只写在页头
  assert.ok(cn.includes("中文版本为准"));
  assert.ok(en.includes("The Chinese version of these Terms controls"));
});

test("强制阅读时长与弹层用的常量是同一个", () => {
  assert.equal(CONSENT_MIN_READ_MS, 10_000);
});
/**
 * 渲染层断言：上面那些用例只看**数据**，看不出「数据里的占位符到底有没有被替换掉」。
 * 真出过一次：加粗分支直接切字符串不再解析，页面上印出「停留满 {readSeconds} 秒」——
 * 数据完全合法，测试全绿，页面是坏的。所以在最外层再压一道：渲染成节点之后
 * 不允许残留任何花括号或 ** 标记。
 */

function flatten(node: unknown, out: string[] = []): string[] {
  if (node === null || node === undefined || typeof node === "boolean") return out;
  if (typeof node === "string" || typeof node === "number") {
    out.push(String(node));
    return out;
  }
  if (Array.isArray(node)) {
    for (const child of node) flatten(child, out);
    return out;
  }
  const props = (node as { props?: { children?: unknown } }).props;
  if (props) flatten(props.children, out);
  return out;
}

const RENDER_CTX = { version: TERMS_VERSION, effective: TERMS_EFFECTIVE, readSeconds: CONSENT_MIN_READ_MS / 1000 };

test("渲染后页面上不残留任何占位符或加粗标记", () => {
  for (const doc of [TERMS_CN, TERMS_EN]) {
    for (const text of allStrings(doc)) {
      const rendered = flatten(renderInline(text, RENDER_CTX, doc.lang)).join("");
      assert.ok(!rendered.includes("{"), "占位符没被替换：" + rendered.slice(0, 60));
      assert.ok(!rendered.includes("}"), "占位符没被替换：" + rendered.slice(0, 60));
      assert.ok(!rendered.includes("**"), "加粗标记漏到页面上：" + rendered.slice(0, 60));
    }
  }
});

test("加粗段落里的占位符也会被替换（历史上这里印出过花括号原文）", () => {
  const rendered = flatten(renderInline("停留满 **{readSeconds} 秒**且读至末尾后", RENDER_CTX, "zh")).join("");
  assert.equal(rendered, "停留满 10 秒且读至末尾后");

  const en = flatten(renderInline("**{operator}** may suspend", RENDER_CTX, "en")).join("");
  assert.ok(!en.includes("{") && !en.includes("**"), en);
});