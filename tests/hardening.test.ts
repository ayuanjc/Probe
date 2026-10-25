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
