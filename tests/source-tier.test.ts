/**
 * 来源分档：时间线上「谁说的」那一列。
 *
 * 这条链最容易出的错是**把总结当结论**：档位是来源类型，不是真伪。
 * 所以断言只钉两件事：白名单命中正确，不认识的一律最低档（4）。
 */
import test from "node:test";
import assert from "node:assert/strict";

import { sourceTier, TIER_LABELS } from "@/lib/source-tier";

test("官方 / 一手来源判 1 档", () => {
  for (const host of ["www.sec.gov", "static.cninfo.com.cn", "arxiv.org", "nvidia.com", "www.pbc.gov.cn", "miit.gov.cn"]) {
    const t = sourceTier({ host });
    assert.equal(t.tier, 1, host + " 应为 1 档");
    assert.equal(t.label, TIER_LABELS[1]);
  }
});

test("政府域名后缀（含子域）直接 1 档，不必进白名单", () => {
  for (const host of ["beian.miit.gov.cn", "www.stats.gov.cn", "ndrc.gov.cn", "example.gov"]) {
    assert.equal(sourceTier({ host }).tier, 1, host);
  }
});

test("主流媒体判 2 档", () => {
  for (const host of ["www.reuters.com", "apnews.com", "www.thepaper.cn", "yicai.com", "www.caixin.com"]) {
    assert.equal(sourceTier({ host }).tier, 2, host);
  }
});

test("行业媒体与行业社区判 3 档（域名优先于 provider）", () => {
  assert.equal(sourceTier({ host: "www.ithome.com" }).tier, 3);
  assert.equal(sourceTier({ host: "sspai.com" }).tier, 3);
  assert.equal(sourceTier({ provider: "juejin" }).tier, 3);
  // 从 HN 聚合进来的 IT之家仍然是行业媒体，不是「社区」
  assert.equal(sourceTier({ host: "www.ithome.com", provider: "hn" }).tier, 3);
});

test("聚合榜单与不认识的来源都是 4 档", () => {
  assert.equal(sourceTier({ provider: "baidu" }).tier, 4);
  assert.equal(sourceTier({ provider: "hn" }).tier, 4);
  assert.equal(sourceTier({ host: "some-blog.example.org" }).tier, 4);
  assert.equal(sourceTier({}).tier, 4);
  // 没给域名也没给 provider 时不许编一个「中等档」
  assert.equal(sourceTier({ host: "  ", provider: "" }).tier, 4);
});

test("带端口 / 带路径 / 大小写混写的域名照样认", () => {
  assert.equal(sourceTier({ host: "WWW.Reuters.com:443" }).tier, 2);
  assert.equal(sourceTier({ host: "cninfo.com.cn/announcement/1.pdf" }).tier, 1);
});
