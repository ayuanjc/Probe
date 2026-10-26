/**
 * 上游机器名 → 人话。
 *
 * 两条口径：
 *   - 库里存 id（hn / ithome / baidu…），界面上不印 id —— 那是数据库字段漏到用户脸上；
 *   - **不认识的 id 原样返回**，不许猜、不许折成「其他来源」，猜错比显示陌生 id 更坏。
 */
import test from "node:test";
import assert from "node:assert/strict";

import { knownProviders, providerLabel } from "@/lib/provider-label";

test("已知上游 id 翻成中文（或它自己的品牌名）", () => {
  assert.equal(providerLabel("hn"), "Hacker News");
  assert.equal(providerLabel("ithome"), "IT之家");
  assert.equal(providerLabel("sspai"), "少数派");
  assert.equal(providerLabel("baidu"), "百度热搜");
  assert.equal(providerLabel("juejin"), "掘金");
  assert.equal(providerLabel("bocha"), "博查");
  assert.equal(providerLabel("wiki"), "维基百科");
  assert.equal(providerLabel("fixture"), "离线样本");
});

test("大小写与空白不影响查表", () => {
  assert.equal(providerLabel(" HN "), "Hacker News");
  assert.equal(providerLabel("ITHome"), "IT之家");
});

test("空值与未知 id：不编", () => {
  assert.equal(providerLabel(null), "");
  assert.equal(providerLabel(undefined), "");
  assert.equal(providerLabel(""), "");
  assert.equal(providerLabel("   "), "");
  // 上游新加一个源、我们忘了配映射 —— 显示 id 本身，绝不硬翻。
  assert.equal(providerLabel("weibo"), "weibo");
  assert.equal(providerLabel("zhihu"), "zhihu");
});

test("映射表覆盖了当前所有会落库的 provider", () => {
  const known = new Set(knownProviders());
  for (const id of ["hn", "ithome", "sspai", "baidu", "juejin", "bocha", "tavily", "gdelt", "wiki", "fixture"]) {
    assert.ok(known.has(id), "缺映射：" + id);
  }
});
