import test from "node:test";
import assert from "node:assert/strict";

import { AUTHORITY_TUNING, HIGH_AUTHORITY, authorityOf } from "@/lib/authority";
import { DEFAULT_AUTHORITY } from "@/lib/dossier";

/**
 * 权威度只有两条会被下游真正用到：能不能过 0.7 门槛（grade.ts 的上限 B / 下限 F），
 * 以及同 owner 多票时权重是否一致。所以这里测的是「分类对不对」，不是「数值好不好看」。
 */

test("后缀类：政府/军事/国际组织升到 official，学术升到 academic", () => {
  assert.equal(authorityOf("www.nasa.gov").tier, "official");
  assert.equal(authorityOf("www.nasa.gov").authority, AUTHORITY_TUNING.official);
  assert.equal(authorityOf("mod.mil").tier, "official");
  assert.equal(authorityOf("who.int").tier, "official");
  // 二级后缀：gov.cn 必须一起认出来，否则中文语料全军覆没
  assert.equal(authorityOf("stats.gov.cn").tier, "official");
  assert.equal(authorityOf("mit.edu").tier, "academic");
  assert.equal(authorityOf("ox.ac.uk").tier, "academic");
  assert.equal(authorityOf("tsinghua.edu.cn").tier, "academic");
});

test("白名单：通讯社到 wire（正好等于 0.7 门槛），UGC 降到 0.35", () => {
  assert.equal(authorityOf("www.reuters.com").tier, "wire");
  assert.equal(authorityOf("reuters.com").tier, "wire");
  assert.equal(authorityOf("cn.reuters.com").tier, "wire");
  assert.equal(authorityOf("weibo.com").tier, "ugc");
  assert.equal(authorityOf("m.weibo.com").tier, "ugc");
  assert.equal(authorityOf("weibo.com").authority, AUTHORITY_TUNING.ugc);
});

test("wire 档正好顶到门槛：>= HIGH_AUTHORITY 才够格参与降档", () => {
  assert.equal(AUTHORITY_TUNING.wire, HIGH_AUTHORITY);
  assert.ok(AUTHORITY_TUNING.wire >= HIGH_AUTHORITY);
  // 默认档必须严格低于门槛，否则「没进门表的来源」也能单枪匹马把评级压到 B。
  assert.ok(DEFAULT_AUTHORITY < HIGH_AUTHORITY);
  assert.equal(AUTHORITY_TUNING.general, DEFAULT_AUTHORITY);
});

test("认不出的走 general/0.6，不猜", () => {
  assert.equal(authorityOf("some-random-blog.example").tier, "general");
  assert.equal(authorityOf("some-random-blog.example").authority, DEFAULT_AUTHORITY);
  assert.equal(authorityOf("").tier, "general");
  assert.equal(authorityOf("").authority, DEFAULT_AUTHORITY);
});

test("后缀匹配不是 includes：notgov.com 不该因为含 gov 升档", () => {
  assert.equal(authorityOf("notgov.com").tier, "general");
  assert.equal(authorityOf("fake.edu.evil.com").tier, "general");
});

test("owner 可能带 scheme、www、路径：都要先规整成域名", () => {
  assert.equal(authorityOf("https://www.reuters.com/business/x").tier, "wire");
  assert.equal(authorityOf("  WWW.NASA.GOV  ").tier, "official");
});

/** 四档必须单调，否则「更权威居然分更低」这种错误会悄悄穿过全部单测。 */
test("分档单调：official > academic > wire > general > ugc", () => {
  const order = ["official", "academic", "wire", "general", "ugc"] as const;
  for (let i = 1; i < order.length; i += 1) {
    assert.ok(
      AUTHORITY_TUNING[order[i - 1]] > AUTHORITY_TUNING[order[i]],
      order[i - 1] + " 应高于 " + order[i],
    );
  }
});
