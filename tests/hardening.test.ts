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
test("按人额度按「操作」记点：三处入口都在操作开始时记点，界面文案说的是点", () => {
  const llmSrc = readFileSync("src/lib/llm.ts", "utf8");
  // 点数定义只有一处；提问 1 / 面板 1 / 核验 3 是产品口径，改了要同步 doc 与界面。
  assert.match(llmSrc, /OP_UNITS = \{ search: 1, module: 1, verify: 3 \} as const/);
  assert.match(llmSrc, /export function chargeOperation/);
  // 余额不足时「放行但标记降级」：直接在此处 return false 会让页面什么都没发生。
  assert.match(llmSrc, /state\.blocked = true/);
  assert.match(llmSrc, /return state\.blocked/);
  // 三个入口各自记一次点：漏掉任何一个，那条链路的用量就不进个人的账。
  assert.match(readFileSync("src/app/api/search/route.ts", "utf8"), /chargeOperation\(OP_UNITS\.search\)/);
  assert.match(readFileSync("src/app/api/module/route.ts", "utf8"), /chargeOperation\(OP_UNITS\.module\)/);
  assert.match(readFileSync("src/app/api/verify/route.ts", "utf8"), /chargeOperation\(OP_UNITS\.verify\)/);
  // 后台表格两种口径都要露出来：只给点数会让人以为「上游调用数 = 点数」，只给调用数则对不上判定。
  const quotaTab = readFileSync("src/components/admin/QuotaTab.tsx", "utf8");
  assert.match(quotaTab, /今日额度（点）/);
  assert.match(quotaTab, /上游调用/);
  assert.match(quotaTab, /PROBE_DAILY_LLM_UNITS_PER_USER/);
});

/* ---------------------- node:sqlite 只能运行时取 ---------------------- */

test("node:sqlite 不用 require/import 字面量取，否则构建能过、一调接口就 500", () => {
  const dbSrc = readFileSync("src/lib/db/index.ts", "utf8");
  // 2026-10-25 实测：tsc 绿、npm test 绿、next build 绿，next start 后第一次调 /api/history 直接
  //   Error: Cannot find module 'node:sqlite': Unsupported external type Url for commonjs reference
  // 因为打包器把 require("node:") 当外部引用去解析。这条断言是唯一能在 CI 里挡住它的东西
  // （单元测试跑的是编译产物，不经过打包器，所以永远发现不了）。
  // 先去掉注释：文件头为了解释这个坑，正文里就写了 require("node:sqlite") 这个词。
  const dbCode = dbSrc.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  assert.doesNotMatch(dbCode, /require\(\s*"node:sqlite"\s*\)/);
  assert.doesNotMatch(dbCode, /from\s+"node:sqlite"/);
  assert.match(dbSrc, /getBuiltinModule/);
  // 拿不到时要说清楚缺什么，而不是抛一个 undefined is not a constructor。
  assert.match(dbSrc, /需要 22\.5\+/);
});

test("搜索与核验都把记录写在 finally 里，中途断开也留得下", () => {
  const searchSrc = readFileSync("src/app/api/search/route.ts", "utf8");
  const verifySrc = readFileSync("src/app/api/verify/route.ts", "utf8");
  // 写在 for-await 之后、try 之外的写法，会在客户端断开（signal abort 抛错）时整条记录消失 ——
  // 而断开恰恰是最常见的结束方式（关页面、切标签）。
  assert.match(searchSrc, /finally \{[\s\S]{0,400}?persistQuietly\(/);
  assert.match(verifySrc, /persistQuietly\(verifyTraceToQuery/);
  // 区域要在有请求上下文的时刻取一次：SSE 的 start() 可能在路由返回后才跑，那时 ALS 已经没了。
  assert.match(verifySrc, /const stamped = \(\): RecordContext =>/);
  // 历史是最后一步：它失败不能影响已经上屏的内容。
  assert.match(readFileSync("src/lib/history-collect.ts", "utf8"), /console\.warn\("\[history\]/);
});

/* ------------------------- 运行时计数（埋点） ------------------------- */

test("计数挂在真实入口上：三条链路各记一次操作，降级原因从 trace 里取", () => {
  // 计数是「今天有人在用吗」的唯一依据，少挂一处就等于那天的那类操作凭空消失。
  for (const [file, op] of [
    ["src/app/api/search/route.ts", "search"],
    ["src/app/api/verify/route.ts", "verify"],
    ["src/app/api/module/route.ts", "module"],
  ] as const) {
    const src = readFileSync(file, "utf8");
    assert.match(src, new RegExp('recordOp\\x28"' + op + '"\\x29'), file + " 没有记 " + op);
  }
  // 降级原因来自 trace（和写历史用的是同一份数据），不能另找一份口径。
  assert.match(readFileSync("src/app/api/search/route.ts", "utf8"), /recordDegraded\(trace\.degraded\)/);
  assert.match(readFileSync("src/app/api/verify/route.ts", "utf8"), /recordDegraded\(trace\.degraded\)/);
  // 计数只数次数，不认人：一旦有人往里塞用户名，面板就变成了行为记录。
  const counters = readFileSync("src/lib/ops-counters.ts", "utf8");
  assert.doesNotMatch(counters, /username|user_id|userId/);
});

/* ------------------------- 关注实体（P1） ------------------------- */

test("关注命中挂在 cron/heat 上，且失败不会拖垮热榜", () => {
  const cron = readFileSync("src/app/api/cron/heat/route.ts", "utf8");
  // 只在 watchEnabled() 时才落库：历史关掉时这个库根本不存在，去碰它就是崩。
  assert.match(cron, /if \(watchEnabled\(\)\) \{/);
  assert.match(cron, /recordHits\(stories\)/);
  // 过期清理由同一次 cron 顺带跑（与历史清理同一处），否则「保留 30 天」只是文档里的一句话。
  assert.match(cron, /pruneHits\(\)/);
  // 关注写失败不能把热榜计算变成 500：热榜是主功能，关注是附带的。
  assert.match(cron, /console\.warn\("\[watch\]/);
  // 只拿「进入统计」的那批 story，不用 rawStories —— 被过滤掉的噪音不该触发命中。
  // 注释里会提到 rawStories 这个词，所以先剥掉注释再判。
  const cronCode = cron.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  assert.match(cronCode, /topic\.stories/);
  assert.doesNotMatch(cronCode, /rawStories/);
});

test("watch 路由都过鉴权与跨站检查，且不落正文", () => {
  for (const file of [
    "src/app/api/watch/route.ts",
    "src/app/api/watch/hits/route.ts",
    "src/app/api/watch/read/route.ts",
    "src/app/api/watch/suggest/route.ts",
  ]) {
    const src = readFileSync(file, "utf8");
    assert.match(src, /requireUser\(request\)/, file + " 少了鉴权");
    assert.match(src, /isCrossSite\(request\)/, file + " 少了跨站检查");
    assert.match(src, /watchEnabled\(\)/, file + " 没走功能开关");
  }
});

test("关注只存索引：命中表里没有正文列，也没有会认人的字段", () => {
  const store = readFileSync("src/lib/watch-store.ts", "utf8");
  // 正文一旦入库，我们就是内容托管方 —— 口径与 queries 表一致：只存标题与链接。
  const hitColumns = store.slice(store.indexOf("INSERT OR IGNORE INTO watch_hits"), store.indexOf("for (const hit of matched.hits)"));
  assert.doesNotMatch(hitColumns, /content|body|text|summary/i);
  // 不认人：没有邮箱/手机号列，也没有任何推送地址。
  assert.doesNotMatch(store, /email|phone|webhook|telegram/i);
});
/* ------------------------- 国内热议榜单（C 期 · B 阶段） ------------------------- */

test("国内榜单只许打两个已知上游，且不许认人", () => {
  const src = readFileSync("src/lib/hotlist.ts", "utf8");
  // 上游清单必须写死在代码里：一旦有人让它从环境变量/用户输入里取 URL，
  // 服务端就成了 SSRF 跳板（cron 是内网唯一能出网的进程）。
  // UA 字符串里带着我们自己的域名，那不是请求目标，先摘掉再统计。
  const noUA = src.replace(/const UA = "[^"]*";/, "");
  const urls = [...noUA.matchAll(/https?:\/\/[^"\s]+/g)].map((m) => m[0]);
  const hosts = new Set(urls.map((u) => new URL(u).host));
  assert.deepEqual([...hosts].sort(), ["api.juejin.cn", "juejin.cn", "top.baidu.com"]);
  assert.doesNotMatch(src, /user_id|userId|username|email|phone/i);
});

test("榜单解析只放行 http(s) 链接：javascript:/data: 是 XSS 入口", () => {
  const src = readFileSync("src/lib/hotlist.ts", "utf8");
  const fn = src.slice(src.indexOf("function httpUrl"), src.indexOf("function httpUrl") + 400);
  // 白名单式判断：只认 ^https?://，其余（javascript:/data:/blob:）一律返回空串。
  assert.match(fn, /\^https\?:\\\/\\\//);
  assert.match(fn, /return ""/);
  assert.match(fn, /u\.protocol === "http:" \|\| u\.protocol === "https:"/);
});

test("cron 里的榜单块失败不拖垮热榜，且不吃 force", () => {
  const cron = readFileSync("src/app/api/cron/heat/route.ts", "utf8");
  // 不带 force：缓存就是限速闸门，每 5 分钟一轮的定时器不该把上游打成每秒一问。
  assert.match(cron, /getHotLists\(\)/);
  assert.doesNotMatch(cron, /getHotLists\(true\)/);
  // 拿不到榜单只是少一块，不能把整轮 cron 变 500。
  const block = cron.slice(cron.indexOf("getHotLists"));
  assert.match(block, /try \{/);
  assert.match(block, /console\.warn\("\[hotlist\]/);
});

test("热榜 cron 打的是根路径，不是搬家前的 /probe 前缀", () => {
  const sh = readFileSync("scripts/server/heat-cron.sh", "utf8");
  // 2026-10-26 的真实事故：站点搬到根之后脚本还打 /probe/api/cron/heat，
  // 每 30 分钟回 404 连挂 18 小时，热榜快照与关注命中全停，而日志里只有一行 http=404。
  // 注释里会提到这个旧地址，先剥掉 bash 注释再判。
  const code = sh
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n");
  assert.doesNotMatch(code, /\/probe\/api\//, "改回旧的 /probe 前缀就等于把 cron 打瞎");
  assert.match(code, /127\.0\.0\.1:3215\/api\/cron\/heat/);
  // 请求头名字与路由里读的那个必须一致，否则每次都是 401 —— 同样是「跑着但什么都没做」。
  assert.match(code, /x-probe-cron-secret/);
});

test("榜单不进热度公式：heat.ts 里没有它", () => {
  const heat = readFileSync("src/lib/heat.ts", "utf8");
  assert.doesNotMatch(heat, /hotlist|baidu|juejin/i);
});



/* ------------------------- 中文科技前沿（A 阶段） ------------------------- */

test("中文源用中文匹配器：换回英文那套等于让中文榜单永远为空", () => {
  const cnHistory = readFileSync("src/lib/cn-history.ts", "utf8");
  const cnTrending = readFileSync("src/lib/cn-trending.ts", "utf8");
  // matchTopicNames 只按 _a.en_ 建正则（\b TSMC \b），中文标题一条都命中不了。
  // 空榜在页面上看起来像「今天没事发生」—— 不是 error，所以最容易长期没人发现。
  assert.match(cnHistory, /matchTopicNamesZh/);
  assert.match(cnTrending, /matchTopicNamesZh/);
  assert.doesNotMatch(cnHistory, /\bmatchTopicNames\(/, "不许退回只认英文别名的匹配");
  assert.doesNotMatch(cnTrending, /\bmatchTopicNames\(/);
  // 展示名必须与 HN 那条一致：同一个实体在两块榜上不能叫两个名字。
  const terms = readFileSync("src/lib/topic-terms.ts", "utf8");
  assert.match(terms, /export function matchTopicNamesZh/);
  assert.match(terms, /CJK_RE\.test\(a\.zh\[0\]\) \? a\.zh\[0\] : a\.en/, "展示名规则要与英文那条相同");
});

test("基线只从今天开始攒：不许假装有历史，也不许把计数写进数据库", () => {
  const src = readFileSync("src/lib/cn-history.ts", "utf8");
  // 这两个源没有历史检索接口，往回补是不可能的。代码里不该出现「回溯 N 天」的抓取。
  assert.match(src, /from "\.\/topic-terms"/, "匹配口径只在这里实现一次");
  assert.match(src, /cn-history\.json/, "落在 .cache，与 hn-history.json 同一个位置");
  assert.doesNotMatch(src, /user_id|username|email|phone/i, "基线里不该出现任何人的标识");
  // 日计数的去重靠当日 URL 集合；没有它，cron 每 30 分钟一轮会把同一篇文章数 20 次。
  assert.match(src, /known\.has\(url\)/);
  assert.match(src, /MAX_SEEN_URLS/);
});

test("cron 记中文源基线：失败只 warn，不拖垮整轮", () => {
  const cron = readFileSync("src/app/api/cron/heat/route.ts", "utf8");
  assert.match(cron, /cnTrendingEnabled\(\)/);
  assert.match(cron, /recordCnStories\(/);
  // recentCnStories 而不是快照里的 topics：快照每话题只留 3 条，拿它记基线会把计数记小。
  assert.match(cron, /recentCnStories\(\)/);
  const block = cron.slice(cron.indexOf("cnTrendingEnabled()"));
  assert.match(block, /try \{/);
  assert.match(block, /console\.warn\("\[cn\]/);
  // 中文源的 story 也要进关注匹配，否则「关注了台积电」在 IT之家 出现时不算命中。
  assert.match(cron, /collectCnStories\(snap\)/);
});

test("中文源不冒充全网热点：状态标签只认自己那份基线", () => {
  const src = readFileSync("src/lib/cn-trending.ts", "utf8");
  // 基线来自 cn-history（readCnHistory），不是 hn-history —— 两套分布不能共用一把尺子。
  assert.match(src, /readCnHistory/);
  assert.doesNotMatch(src, /ensureHistory|hn-history/, "拿 HN 的基线条说中文源的事，r7 会来回抽动");
  // 序列不够时不出状态：seriesStats 返回 null 就 continue。
  assert.match(src, /if \(!stats\) continue;/);
  // 上游地址必须写死 https，禁止从环境变量拼外部地址（那会变成半个 SSRF 入口）。
  assert.doesNotMatch(src, /process\.env\.PROBE_CN_[A-Z_]*URL/);
  assert.match(src, /const ITHOME_LIST = "https:\/\//);
  assert.match(src, /const SSPAI_LIST = "https:\/\//);
});

test("上游 id 不许直接印在界面上：WatchPanel 必须过 providerLabel", () => {
  const panel = readFileSync("src/components/WatchPanel.tsx", "utf8");
  assert.match(panel, /from "@\/lib\/provider-label"/);
  assert.match(panel, /providerLabel\(h\.provider\)/);
  // 直接拼 h.provider 就是把 hn / ithome / baidu 这些库字段漏到用户脸上。
  assert.doesNotMatch(panel, /\+ h\.provider(?!\s*\))/);
});

test("榜单时间与抓取时间分开：百度自己的 updateTime 不许被丢掉", () => {
  const src = readFileSync("src/lib/hotlist.ts", "utf8");
  assert.match(src, /export function parseBaiduUpdatedAt/);
  assert.match(src, /updatedAt: parseBaiduUpdatedAt/);
  // 一次抓取喂两个解析器：分两次 fetchJson 等于让上游在两秒里回两份不一致的数据。
  assert.match(src, /const json = await fetchJson\(def\.endpoint\);/);
  assert.match(src, /updatedAt: def\.updatedAt\?\.\(json\)/);
  // 没有 updatedAt 的源（掘金）不许编一个出来：失败分支统一给 undefined。
  const board = readFileSync("src/components/HotListBoard.tsx", "utf8");
  assert.match(board, /list\.updatedAt \?/);
});


/* ---------------------- 公开核验（匿名）与公开时间线 ---------------------- */

test("匿名核验必须显式声明：没有 x-probe-anon 的请求照旧 401", () => {
  const src = readFileSync("src/app/api/verify/route.ts", "utf8");
  assert.match(src, /request.headers.get\("x-probe-anon"\) === "1"/);
  // 关键：不能写成「auth 失败就走匿名」—— 那样任何丢了 cookie 的请求都会掉进更贵的路径。
  assert.match(src, /if \(!auth\.ok && !wantsAnon\) return auth\.response;/);
  assert.match(src, /const ANON_MAX_CHARS = 2_000;/);
  // 只收正文：代抓链接等于开免费代理，抓取目标由请求方指定。
  assert.match(src, /return jsonError\(422, "anon_text_only"/);
  assert.match(src, /takeAnonDaily\(\)/);
});

test("匿名核验不落历史、不推进用户额度：scope 用 anon 前缀，历史按 ctx.userId 挡住", () => {
  const src = readFileSync("src/app/api/verify/route.ts", "utf8");
  assert.match(src, /\{ key: "anon:" \+ digest, label: "匿名访客" \}/);
  // 两处 persist（json 与 sse）都要挡住：只改一处，匿名核验照样会往 queries 表里写行。
  const guards = src.match(/if \(ctx\.userId\) persistQuietly/g) ?? [];
  assert.equal(guards.length, 2, "json 与 sse 两处都必须按 ctx.userId 挡住，实际 " + guards.length);
  assert.doesNotMatch(src, /anonDefault|anon_disabled.*requireUser/);
});

test("实体命中落库只吃标题：表里不许出现 user_id，INSERT 不许带正文", () => {
  const migrate = readFileSync("src/lib/db/migrate.ts", "utf8");
  const start = migrate.indexOf("CREATE TABLE entity_hits");
  assert.ok(start > 0, "migrate 里应有 entity_hits");
  // 只看 CREATE TABLE 的列定义：注释里写着「没有 user_id」是口径说明，不算违规。
  const table = migrate.slice(start, migrate.indexOf(");", start));
  assert.doesNotMatch(table, /user_id/, "公开时间线一旦带 user_id 就能反推谁看过");
  const store = readFileSync("src/lib/entity-track.ts", "utf8");
  const insert = store.slice(store.indexOf("INSERT OR IGNORE INTO entity_hits"));
  assert.match(insert.slice(0, 300), /title|url/);
  assert.doesNotMatch(insert.slice(0, 300), /content|summary|body/, "正文不落库");
});

test("实体追踪在 cron 里是可选段：开关关掉不跑、失败只 warn", () => {
  const cron = readFileSync("src/app/api/cron/heat/route.ts", "utf8");
  assert.match(cron, /import \{ entityEnabled, pruneEntityHits, recordEntityHits/);
  assert.match(cron, /if \(entityEnabled\(\) && entityStories\.length > 0\)/);
  assert.match(cron, /recordEntityHits\(entityStories\)/);
  assert.match(cron, /pruneEntityHits\(\)/);
  const block = cron.slice(cron.indexOf("entityEnabled() && entityStories"));
  assert.match(block, /try \{/);
  assert.match(block, /console\.warn\("\[entity\]/);
});

test("公开实体接口是只读的：只有 GET，不认人", () => {
  const src = readFileSync("src/app/api/entity/route.ts", "utf8");
  assert.match(src, /export async function GET\(request: Request\)/);
  assert.doesNotMatch(src, /export async function (POST|PUT|PATCH|DELETE)/);
  assert.doesNotMatch(src, /requireUser|getSession|currentUser/, "公开接口不该 import 任何用户态");
  assert.match(src, /createLimiter\(\{[\s\S]{0,80}PROBE_ENTITY_RATE_PER_MIN/);
});

test("公开页不 import 用户态：/check 与 /e/*、/entities 陌生人能直接看到", () => {
  for (const file of ["src/app/check/page.tsx", "src/app/entities/page.tsx", "src/app/e/[key]/page.tsx"]) {
    const src = readFileSync(file, "utf8");
    assert.doesNotMatch(src, /requirePageUser|requireUser|cookies\(/, file + " 不该依赖登录态");
    assert.match(src, /export const dynamic = "force-dynamic";/, file + " 需要现算");
  }
});

test("来源分档不许调模型：档位是来源类型，不是真伪判定", () => {
  const src = readFileSync("src/lib/source-tier.ts", "utf8");
  assert.doesNotMatch(src, /generateText|generateObject|\bllm\b/, "一旦引入模型打分就是在替读者下结论");
  assert.match(src, /未分级来源，按最低档处理/);
});

test("匿名 scope 不能当账号用：userId 只从 \"u:\" 前缀里取", () => {
  const src = readFileSync("src/app/api/verify/route.ts", "utf8");
  // replace(/^u:/, "") 这种写法会把 "anon:<hash>" 整串当成 userId，
  // 于是匿名核验照样往 queries 表写一行，user_id 还带着那份内存哈希。
  assert.doesNotMatch(src, /userId: scope\.key\.replace/);
  assert.match(src, /scope\.key\.startsWith\("u:"\) \? scope\.key\.slice\(2\) : ""/);
});

test("匿名核验的最小字数与正文门槛一致：别让页面写 60、后端要 120", () => {
  const route = readFileSync("src/app/api/verify/route.ts", "utf8");
  const doc = readFileSync("src/lib/verify-doc.ts", "utf8");
  assert.match(route, /const ANON_MIN_CHARS = 120;/);
  assert.match(doc, /body\.length < 120/);
  const panel = readFileSync("src/components/CheckPanel.tsx", "utf8");
  assert.match(panel, /const MIN_CHARS = 120;/);
});
