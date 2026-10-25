/**
 * 加固回归：这些都是「静默错」型缺陷 —— 界面上什么都不报，但数字/卡片/账目是错的。
 * 每条断言都对着一个具体的误判场景写，别把它们改成只验证「函数能跑」。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { splitSegments } from "@/lib/translate";
import { compile } from "@/lib/compile";
import type { Dataset, ModuleSpec } from "@/lib/schemas";

/* ------------------------------ 分段总数 ------------------------------ */

test("splitSegments：超上限时回的是截断后段数 + 截断前总数", () => {
  const para = "这是一个足够长的段落，用来测试分段。".repeat(30);
  const text = Array.from({ length: 10 }, (_, i) => para + i).join("\n\n");
  const out = splitSegments(text, 3);
  assert.equal(out.segments.length, 3);
  assert.equal(out.truncated, true);
  /**
   * total 必须是截断前的真实段数。
   *
   * 核验覆盖率用它当分母；用 segments.length 的话分母恒等于上限，
   * segments:extracted_X_of_Y 永远不会触发，partial 结果会少报一条真实原因。
   */
  assert.ok(out.total > 3, "截断前总数必须大于上限，实际 " + out.total);
});

test("splitSegments：没超上限时 total 等于段数", () => {
  const out = splitSegments("第一段。\n\n第二段。", 48);
  assert.equal(out.total, out.segments.length);
  assert.equal(out.truncated, false);
});

/* ---------------------------- 数据集校验 ---------------------------- */

const ds: Dataset = {
  id: "ds-1",
  name: "示例",
  fields: [
    { name: "月份", type: "string" },
    { name: "值", type: "number" },
  ],
  rows: [{ 月份: "1 月", 值: 3 }],
};

function spec(kind: ModuleSpec["kind"], dataset: string): ModuleSpec {
  return {
    id: "m1",
    kind,
    title: "标题",
    dataset,
    encode: kind === "table" || kind === "kpi" ? {} : { x: "月份", y: "值" },
  } as ModuleSpec;
}

test("compile：表格指向不存在的数据集也要报 unknown_dataset", () => {
  /**
   * table/kpi 不经过 ECharts，但它们照样读 dataset 渲染。
   * 以前这两种卡片对不存在的数据集直接回 ok:true —— 卡片空着上屏，
   * module.error 里什么都没有（图表至少还会说一句「找不到对应的数据集」）。
   */
  const out = compile(spec("table", "ds-missing"), ds);
  assert.equal(out.ok, false);
  assert.equal(out.ok === false ? out.reason : "", "unknown_dataset");
});

test("compile：KPI 同口径", () => {
  const out = compile(spec("kpi", "ds-missing"), ds);
  assert.equal(out.ok, false);
});

test("compile：数据集对得上时表格照常放行", () => {
  const out = compile(spec("table", "ds-1"), ds);
  assert.equal(out.ok, true);
});

/* --------------------------- 源码级护栏 --------------------------- */

const verifyPipeline = readFileSync("src/agents/verify-pipeline.ts", "utf8");
const analyzeSrc = readFileSync("src/agents/analyze.ts", "utf8");

test("核验覆盖率用文档里的真实段数当分母", () => {
  // 分母写成 segments.length 时它恒等于上限 24，partial 少报理由。
  assert.match(verifyPipeline, /segmentsTotal: doc\.segmentsTotal/);
  assert.ok(!/segmentsTotal: segments\.length/.test(verifyPipeline), "不能用分段数组长度当分母");
});

test("检索链路抽出的引文要回原文核对", () => {
  // 只查长度不碰原文 = 模型编的引文会直接进结论。
  assert.match(analyzeSrc, /locateQuote\(hay, c\.quote\)/);
  assert.match(analyzeSrc, /claims:quote_miss_/);
});

/* --------------------------- 首屏说明 --------------------------- */

const loginPage = readFileSync("src/app/login/page.tsx", "utf8");
const signupPage = readFileSync("src/app/signup/page.tsx", "utf8");
const whatIsThis = readFileSync("src/components/WhatIsThis.tsx", "utf8");

test("登录页与注册页都把「这是什么」摆在表单旁边", () => {
  // 陌生人落在 /login 时眼前只有一个密码框和「仅限受邀用户使用」——
  // 他没法判断值不值得去要一个邀请码。这段说明被删掉不会有任何报错，所以钉在这里。
  for (const [name, src] of [
    ["login", loginPage],
    ["signup", signupPage],
  ] as const) {
    assert.match(src, /WhatIsThis/, name + " 没有引入说明组件");
    assert.match(src, /一次提问，回一组/, name + " 首屏缺少一句话定位");
  }
});

test("说明里必须写清三件事，且保留 AI 生成标识", () => {
  // 产品唯一的诚实卖点：证据、三态判定、数字可回溯。少一条就变成营销文案。
  assert.match(whatIsThis, /每条断言都挂着证据/);
  assert.match(whatIsThis, /支持 \/ 矛盾 \/ 无法判定/);
  assert.match(whatIsThis, /点得回原文/);
  // 备案口径：页面必须显著标识 AI 生成内容（生成式 AI 办法第 12 条）。
  assert.match(whatIsThis, /由模型生成/);
  assert.match(whatIsThis, /以原始信源为准/);
});

const verifyPanel = readFileSync("src/components/VerifyPanel.tsx", "utf8");

test("文档核验页也有说明，且说的是「区间」不是「真假判决」", () => {
  // 这页最容易被人当成「AI 判定真假」来用；说明必须挡住这个误读。
  assert.match(verifyPanel, /WhatIsThis/);
  assert.match(verifyPanel, /外部吻合度|外部材料/);
  assert.match(verifyPanel, /支持 \/ 矛盾 \/ 无法判定/);
  assert.match(verifyPanel, /不是真假判决/);
  // 说明组件必须可传参，否则两页只能共用一份检索口径的文案。
  assert.match(whatIsThis, /points\?: WhatIsThisPoint\[\]/);
  assert.match(whatIsThis, /points = DEFAULT_POINTS/);
});
/* --------------------------- 后台设置的可写面 --------------------------- */

const settingsTab = readFileSync("src/components/admin/SettingsTab.tsx", "utf8");
const quotaTab = readFileSync("src/components/admin/QuotaTab.tsx", "utf8");
const quotaCaps = readFileSync("src/components/admin/QuotaCaps.tsx", "utf8");

test("设置页能改密码，且走的是 admin PATCH 而不是自己拼请求", () => {
  // 这条链路曾被误以为「后台只能重置密码、不能改」；真正的约束是：密码规则、
  // 强制改密、撤销全部会话、审计都必须由 src/lib/auth/account.ts 裁决。
  assert.match(settingsTab, /api\("\/api\/admin\/users"/);
  assert.match(settingsTab, /newPassword: pwdValue/);
  assert.match(settingsTab, /mustChangePassword: pwdMust/);
  // 失败不能清空输入：管理员输了 20 位、服务端拒了，输入框一空他只会以为改成功了。
  assert.match(settingsTab, /if \(!r\.ok\) \{[\s\S]{0,120}onSay\(\{ kind: "err"/);
});

test("额度编辑只有一份实现，两个页面共用", () => {
  // 两处各写一份输入框 → 迟早一边校验 1–1000000、另一边忘了上限。
  assert.match(settingsTab, /<QuotaCaps /);
  assert.match(quotaTab, /<QuotaCaps /);
  assert.match(quotaCaps, /\/api\/admin\/ops/);
  // 整体覆盖写：只改一个字段时另一个要带上当前生效值，否则等于把另一条清掉。
  assert.match(quotaCaps, /void save\(\{ globalCap: g, perUserCap: p \}/);
});

test("部署态那半仍是只读，页面也明说了为什么", () => {
  // 给浏览器一个「改自己启动参数」的写入口 = 拿到 admin 会话就能关掉鉴权、换模型端点。
  assert.match(settingsTab, /部署态配置（只读）/);
  assert.match(settingsTab, /systemctl restart probe-web/);
  assert.doesNotMatch(settingsTab, /process\.env/);
});
test("robots.txt 与 sitemap 由代码生成，规则与站点真实可见面一致", () => {
  const robotsSrc = readFileSync("src/app/robots.ts", "utf8");
  const sitemapSrc = readFileSync("src/app/sitemap.ts", "utf8");
  // 后台与 API 不能被抓：管理台路径只能从 ADMIN_PATH 取（写死路径会被 admin-path.test 拦），
  // /api 全是 JSON。
  assert.match(robotsSrc, /ADMIN_PATH/);
  assert.match(robotsSrc, /"\/api\/"/);
  // 不写 sitemap 就要等爬虫自己猜。
  assert.match(robotsSrc, /sitemap:/);
  // 地址来自部署配置，不读请求头 —— 伪造 Host 不能让 sitemap 写满陌生域名。
  assert.match(robotsSrc, /siteUrl\(\)/);
  assert.doesNotMatch(robotsSrc, /headers\(\)/);
  // sitemap 只列公开页：登录墙与重定向页放进去等于把权重摊薄。
  assert.match(sitemapSrc, /"\/login"/);
  assert.doesNotMatch(sitemapSrc, /"\/ayuanjc"/);
  assert.doesNotMatch(sitemapSrc, /"\/account"/);
  assert.doesNotMatch(sitemapSrc, /"\/metrics"/);
});

