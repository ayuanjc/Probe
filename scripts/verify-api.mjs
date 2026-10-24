#!/usr/bin/env node
/**
 * /api/verify 的验收脚本（VERIFY-ARCH §6.2 的 Phase 2 断言里，能脱机判定的那几条）。
 *
 * 用法：先 npm run build，再起服务（把限流放开到够跑一轮）：
 *   PROBE_VERIFY_RATE_PER_MIN=60 npx next start -p 3211
 *   BASE=http://127.0.0.1:3211 node scripts/verify-api.mjs
 *
 * 默认限流是 2 次/分钟，一轮验收要发 5 个请求 —— 忘了放开就会在第四条上撞 429。
 * 脚本对 429 做了退避重试（读 Retry-After，最多两次），但那是兜底，不是设计意图：
 * 一条「被限流」的 FAIL 什么都证明不了。
 *
 * 设计上的两条纪律：
 *   1. **不伪造通过**。需要模型 key 的断言（伪造 quote 被丢、120.4 vs 32 判冲突、
 *      3.2 billion 与 32 亿折算为同一数值）在这里一律输出 SKIP + 原因，不写成 pass。
 *      那些规则由 tests/claim-extract.test.ts 与 tests/dossier.test.ts 在库层面钉住。
 *   2. **只断言契约**，不断言分数好不好看。分数是数据决定的，契约是我们决定的。
 */

const BASE = process.env.BASE ?? "http://127.0.0.1:3211";

/**
 * 鉴权上线后 /api/verify 需要登录态。两种给法（都不设就会拿到 401）：
 *   PROBE_USER=alice PROBE_PASS=... node scripts/verify-api.mjs   —— 脚本自己登一次
 *   PROBE_COOKIE="probe_session=..."                              —— 直接用现成的 cookie
 * 登录本身也走 /api/auth/login 的 5 次/分钟限流，别在同一个 IP 上反复重跑。
 */
const LOGIN_USER = process.env.PROBE_USER ?? "";
const LOGIN_PASS = process.env.PROBE_PASS ?? "";
let cookie = process.env.PROBE_COOKIE ?? "";

async function ensureSession() {
  if (cookie || !LOGIN_USER) return;
  const res = await fetch(BASE + "/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: LOGIN_USER, password: LOGIN_PASS }),
  });
  const jar = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
  const hit = jar.find((c) => c.startsWith("probe_session="));
  if (!hit) {
    console.log("      登录失败（status=" + res.status + "）：PROBE_USER/PROBE_PASS 不对，或撞了登录限流。");
    return;
  }
  cookie = hit.split(";")[0];
}

let pass = 0;
let fail = 0;
let skip = 0;

function ok(name, extra) {
  pass += 1;
  console.log("PASS  " + name + (extra ? "  — " + extra : ""));
}
function no(name, why) {
  fail += 1;
  console.log("FAIL  " + name + "  — " + why);
}
function sk(name, why) {
  skip += 1;
  console.log("SKIP  " + name + "  — " + why);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 撞 429 就退避重试：读 Retry-After，缺省等 61 秒（窗口是 60 秒）。一条被限流的 FAIL 什么都证明不了。 */
async function post(body, attempt = 0) {
  const res = await fetch(BASE + "/api/verify", {
    method: "POST",
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify({ ...body, format: "json" }),
  });
  if (res.status === 429 && attempt < 2) {
    const after = Number(res.headers.get("retry-after"));
    const wait = Number.isFinite(after) && after > 0 ? after * 1000 + 500 : 61_000;
    console.log("      （429，等 " + Math.round(wait / 1000) + "s 后重试）");
    await sleep(wait);
    return post(body, attempt + 1);
  }
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

const LONG =
  "公司在 2025 年第三季度实现营业收入 32.4 亿元，同比增长 18.6%。" +
  "管理层在业绩说明会上表示，增长主要来自海外市场，并在报告期内新增两家区域子公司。" +
  "公司同时宣布，2026 年将继续扩大在东南亚的渠道投入，预计资本开支 6 亿元。";

const GRADES = ["A+", "A", "B+", "B", "C+", "C", "D", "E", "F", "N/A"];

async function main() {
  // ── 前置：登录态（没有它，下面每一条都会是 401）──
  await ensureSession();
  if (!cookie) {
    console.log("HINT  没带登录态：设置 PROBE_USER/PROBE_PASS 或 PROBE_COOKIE 后再跑。");
  }

  // ── 契约：能跑通，且段落区间拼回原文 ──
  const a = await post({ text: LONG });
  if (a.status === 401) return no("正常请求返回 200 + JSON", "401 未登录 —— 先设 PROBE_USER/PROBE_PASS");
  if (a.status !== 200 || !a.json) return no("正常请求返回 200 + JSON", "status=" + a.status);
  ok("正常请求返回 200 + JSON");

  const doc = a.json.doc;
  if (!doc || typeof doc.chars !== "number") no("doc.parsed 带 chars", "缺少 doc");
  else ok("doc.parsed 带 chars", "chars=" + doc.chars);

  if (doc && typeof doc.docId === "string" && doc.docId.length >= 8) ok("docId 是稳定指纹", doc.docId);
  else no("docId 是稳定指纹", String(doc && doc.docId));

  if (doc && Array.isArray(doc.segments) && doc.segments.length > 0) {
    const joined = doc.segments
      .slice()
      .sort((x, y) => x.idx - y.idx)
      .map((s) => LONG.slice(s.charStart, s.charEnd))
      .join("");
    if (joined === LONG) ok("分段区间首尾相接且拼回原文", doc.segments.length + " 段");
    else no("分段区间首尾相接且拼回原文", "拼不回");
  } else no("分段非空", "segments 缺失");

  // ── 铁律 9：没判定就不给字母档，也不给 0/0.5 冒充分数 ──
  const scores = a.json.scores;
  if (!scores || !GRADES.includes(scores.grade)) no("scores.grade 在档位表内", String(scores && scores.grade));
  else ok("scores.grade 在档位表内", scores.grade);

  if (scores && scores.counts.judged === 0) {
    if (scores.grade === "N/A" && scores.agreement === null) ok("零判定 → N/A 且 agreement 为 null（不回落 0/0.5）");
    else no("零判定 → N/A 且 agreement 为 null", "grade=" + scores.grade + " agreement=" + JSON.stringify(scores.agreement));
  } else sk("零判定 → N/A", "本轮有判定数 judge=" + (scores && scores.counts.judged));

  if (scores && typeof scores.gradeReason === "string" && scores.gradeReason.length > 0) ok("gradeReason 是机器码", scores.gradeReason);
  else no("gradeReason 是机器码", String(scores && scores.gradeReason));

  // ── 铁律 11：抑制与降级都要外发 ──
  if (Array.isArray(a.json.notes) && Array.isArray(a.json.degraded)) ok("notes / degraded 都外发", "notes=" + a.json.notes.length + " degraded=" + a.json.degraded.length);
  else no("notes / degraded 都外发", "字段类型不对");

  const hasModel = !(a.json.notes ?? []).includes("claims:unavailable");
  if (!hasModel) ok("没接模型时诚实报 claims:unavailable");
  else sk("没接模型时诚实报 claims:unavailable", "本轮接了模型");

  if (a.json.stats && typeof a.json.stats.claims === "number") ok("stats 带 claims 计数", JSON.stringify(a.json.stats));
  else no("stats 带 claims 计数", "stats 缺失");

  // ── §4.5：超长正文先标 truncated ──
  const big = LONG.repeat(400);
  const b = await post({ text: big });
  if (b.json && b.json.doc && b.json.doc.truncated === true) ok("超长正文标 truncated", big.length + " 字符");
  else no("超长正文标 truncated", JSON.stringify(b.json && b.json.doc && b.json.doc.truncated));

  // ── 铁律 8 同族：内网地址不许抓 ──
  const c = await post({ url: "http://127.0.0.1:6379/" });
  const blockedMsg = String(c.json && c.json.message ? c.json.message : "");
  if (c.json && c.json.ok === false && /url_blocked|url_not_allowed/.test(blockedMsg)) ok("内网地址被挡", blockedMsg.slice(0, 40));
  else no("内网地址被挡", "status=" + c.status + " msg=" + blockedMsg.slice(0, 60));

  // ── 输入侧：太短 / 空请求 ──
  const d = await post({ text: "太短了。" });
  if (d.json && d.json.ok === false && /too_short/.test(String(d.json.message))) ok("正文太短 → error 事件", String(d.json.message).slice(0, 40));
  else no("正文太短 → error 事件", JSON.stringify(d.json && d.json.message));

  const e = await fetch(BASE + "/api/verify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{not json",
  });
  if (e.status === 400) ok("非法 JSON → 400");
  else no("非法 JSON → 400", "status=" + e.status);

  // ── 需要模型 key 才能验的三条，明写 SKIP，不装过 ──
  sk("伪造 quote 被丢（铁律 3）", hasModel ? "见 tests/claim-extract.test.ts 的 quote_miss 用例" : "需要模型 key");
  sk("声明值与 quote 数值不一致被丢（铁律 4）", "见 tests/claim-extract.test.ts 的 value_mismatch 用例");
  sk("3.2 billion 与 32 亿折算为同一数值（铁律 4）", "见 tests/dossier.test.ts 与 normalizeValue 用例");

  console.log("");
  console.log("pass " + pass + " / fail " + fail + " / skip " + skip);
  // 用 exitCode 而不是 process.exit()：立刻退出会把还挂着的 keep-alive socket
  // 连根拔掉，Windows 上会看到 libuv 的 uv_handle 断言，退出码变成 127。
  process.exitCode = fail === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error("脚本自身失败：" + (err && err.message ? err.message : String(err)));
  process.exitCode = 2;
});
