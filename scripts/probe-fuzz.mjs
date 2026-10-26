#!/usr/bin/env node
/**
 * 健壮性探针：拿恶意/畸形输入去打每一个 API，只验证一件事 ——
 * **客户端错误必须返回结构化 JSON（带 code），不能是 500 裸栈、不能是 HTML。**
 *
 * 用法：
 *   node scripts/probe-fuzz.mjs                      # 默认打 http://127.0.0.1:3311
 *   BASE=http://127.0.0.1:3215 node scripts/probe-fuzz.mjs
 *   BASE=... STRICT=1 node scripts/probe-fuzz.mjs    # 有 500 就退出码 1（CI 用）
 *
 * 它不是功能测试：不判断业务对不对，只判断"坏输入有没有把进程打崩 / 把栈吐给用户"。
 *
 * 「已解释的非 2xx」不算失败：框架层 405 空体、未配置时的 cron 503 都是既定行为。
 * 判 FAIL 必须只包含真违约 —— 一个永远 FAIL(38) 的脚本等于没有脚本。
 */

const BASE = (process.env.BASE || "http://127.0.0.1:3311").replace(/\/+$/, "");
const STRICT = process.env.STRICT === "1";
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS || 20000);

const BIG = "x".repeat(200 * 1024); // 200KB 字符串：超过多数字段上限
const DEEP = (() => {
  let s = "1";
  for (let i = 0; i < 2000; i += 1) s = "[" + s + "]";
  return s; // 2000 层嵌套：JSON.parse 不炸、递归校验可能炸
})();

/** 每条用例：method, path, body(可选), headers(可选), want（期望的最大可接受状态码区间） */
const cases = [];
const add = (method, path, body, want) => cases.push({ method, path, body, want: want || "4xx" });

// —— 通用畸形体：每个 POST 端点都打一遍 ——
const POST_PATHS = [
  "/api/search",
  "/api/verify",
  "/api/module",
  "/api/dossier",
  "/api/evidence",
  "/api/translate",
  "/api/feedback",
  "/api/history/import",
  "/api/calibration",
  "/api/consent",
  "/api/auth/login",
  "/api/auth/signup",
  "/api/auth/password",
  "/api/auth/logout",
  "/api/admin/invites",
  "/api/admin/users",
  "/api/cron/heat",
  // 关注实体（P1）：POST 加关注、POST 标记已读。
  // 写接口有 10/min 的限流，撞上 429 也算通过（回的是结构化 JSON）。
  "/api/watch",
  "/api/watch/read",
];
const BODIES = [
  ["empty", ""],
  ["not-json", "not json at all"],
  ["null", "null"],
  ["array", "[]"],
  ["number", "42"],
  ["object-empty", "{}"],
  ["deep", DEEP],
  ["huge", JSON.stringify({ query: BIG })],
  ["wrong-types", JSON.stringify({ query: 123, url: [], text: {}, limit: "abc" })],
  ["nan", JSON.stringify({ query: "x", limit: NaN, page: null })],
  ["proto", '{"__proto__":{"polluted":1},"constructor":{"prototype":{"x":1}}}'],
  ["unicode", JSON.stringify({ query: "\u0000\u001b[31m\u202e中文🎯" })],
];
for (const p of POST_PATHS) for (const [name, body] of BODIES) add("POST", p, body);

// —— GET 端点：畸形 query ——
const GETS = ["/api/history", "/api/history/export", "/api/search", "/api/verify", "/api/metrics", "/api/dossier", "/api/evidence", "/api/calibration", "/api/version", "/api/region", "/api/consent", "/api/auth/me", "/api/auth/sessions", "/api/admin/invites", "/api/admin/users", "/api/admin/sessions", "/api/admin/audit", "/api/cron/heat", "/api/watch", "/api/watch/hits", "/api/watch/suggest"];
const QUERIES = [
  "",
  "?q=",
  "?query=%00",
  "?q=" + encodeURIComponent("' OR 1=1 --"),
  "?q=../../../../etc/passwd",
  "?limit=-1",
  "?limit=1e9",
  "?limit=999999999999999999999",
  "?page=NaN&size=abc",
  "?q=" + "a".repeat(8000),
  "?q=%E4%B8%AD&q=%E6%96%87",
  "?__proto__[polluted]=1",
  // 关注命中列表的查询参数：watch 是关注 id，before 是游标，unread 是开关。
  "?watch=../../etc/passwd&limit=-1",
  "?before=999999999999999999999&unread=maybe",
];
for (const p of GETS) for (const q of QUERIES) add("GET", p + q);

// —— 方法/头错配 ——
add("DELETE", "/api/search", "{}");
add("PUT", "/api/search", "{}");
add("POST", "/api/version", "{}");
add("GET", "/api/auth/logout");
add("OPTIONS", "/api/search");
// —— 清空关注必须带确认词：这几条打的就是「畸形 DELETE 会不会把用户的关注全清了」——
// 空体 / 错误确认词 / 往 id 里塞路径，都必须 400，一条都不许删。
add("DELETE", "/api/watch", "");
add("DELETE", "/api/watch", "{}");
add("DELETE", "/api/watch", JSON.stringify({ confirm: "nope" }));
add("DELETE", "/api/watch", JSON.stringify({ confirmno: "DELETE" }));
add("DELETE", "/api/watch?id=../../etc/passwd", "");
add("DELETE", "/api/watch?id=" + encodeURIComponent("' OR 1=1 --"), "");
add("DELETE", "/api/watch/read", "{}");

let idx = 0, bad = [], fivexx = [], nonJson = [], slow = [], known = [];
const stats = new Map();

/**
 * 已知且可解释的非 2xx：不属于「坏输入打崩了服务」，摘出来不算违约。
 * 返回原因串；返回 null 表示这就是违约，交给下面正常归类。
 */
function explained(status, ctype, text) {
  // 路由文件没导出这个方法时 Next 自己回 405 + 空 body，我们的 handler 根本没被调用。
  // 会被人误发的那几个（dossier / evidence 的 GET）已自己导出 405 JSON，剩下的
  // DELETE / PUT / OPTIONS 纯属畸形请求，属于框架行为。
  if (status === 405 && !ctype.includes("json") && text.trim() === "") {
    return "framework_405_empty";
  }
  // 没配 PROBE_CRON_SECRET 时 cron 端点保持关闭 —— 这是设计如此，且回的是结构化 JSON。
  if (status === 503 && text.includes('"cron_disabled"')) return "cron_disabled";
  return null;
}

function classify(status, ctype) {
  if (status >= 500) return "5xx";
  if (status >= 400) return "4xx";
  if (status >= 300) return "3xx";
  return "2xx";
}

async function run(c) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  const started = Date.now();
  let status = 0, ctype = "", text = "", err = "";
  try {
    const res = await fetch(BASE + c.path, {
      method: c.method,
      headers: c.body === undefined ? {} : { "content-type": "application/json" },
      body: c.body === undefined ? undefined : c.body,
      signal: ctrl.signal,
      redirect: "manual",
    });
    status = res.status;
    ctype = res.headers.get("content-type") || "";
    text = (await res.text()).slice(0, 400);
  } catch (e) {
    err = String((e && e.message) || e);
  } finally {
    clearTimeout(t);
  }
  const ms = Date.now() - started;
  const key = classify(status, ctype);
  stats.set(key, (stats.get(key) || 0) + 1);
  if (ms > 5000) slow.push({ ...c, ms, status });

  if (err) {
    bad.push({ ...c, status, err, text });
    return;
  }
  const why = explained(status, ctype, text);
  if (why) {
    known.push({ ...c, status, why });
    return;
  }
  if (status >= 500) {
    fivexx.push({ ...c, status, ctype, text });
    return;
  }
  // 4xx 必须是 JSON（前端按 code 分支），不能是 HTML/纯文本/空
  if (status >= 400 && !ctype.includes("json")) {
    nonJson.push({ ...c, status, ctype, text });
  }
}

async function main() {
  console.log("[fuzz] base=" + BASE + "  cases=" + cases.length);
  const CONCURRENCY = Number(process.env.CONCURRENCY || 4);
  const queue = cases.slice();
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      for (;;) {
        const c = queue.shift();
        if (!c) return;
        idx += 1;
        await run(c);
      }
    }),
  );

  const show = (title, arr, fmt) => {
    if (!arr.length) return;
    console.log("\n" + title + " (" + arr.length + ")");
    for (const it of arr.slice(0, 20)) console.log("  " + fmt(it));
    if (arr.length > 20) console.log("  …还有 " + (arr.length - 20) + " 条");
  };

  console.log("\n[stats]", JSON.stringify(Object.fromEntries(stats)));
  show("✗ 500 / 5xx（必须修：坏输入不该打崩服务）", fivexx, (x) =>
    x.method + " " + x.path + " → " + x.status + "  " + (x.text || "").replace(/\s+/g, " ").slice(0, 160));
  show("✗ 4xx 但返回的不是 JSON（前端无法按 code 分支）", nonJson, (x) =>
    x.method + " " + x.path + " → " + x.status + " " + x.ctype + "  " + (x.text || "").replace(/\s+/g, " ").slice(0, 120));
  show("✗ 请求异常 / 超时", bad, (x) => x.method + " " + x.path + " → " + (x.err || "") + " " + (x.text || ""));
  show("△ 慢响应 >5s", slow, (x) => x.method + " " + x.path + " → " + x.status + " " + x.ms + "ms");

  if (known.length) {
    const byWhy = new Map();
    for (const it of known) byWhy.set(it.why, (byWhy.get(it.why) || 0) + 1);
    console.log(
      "\n○ 已解释的可接受非 2xx (" +
        known.length +
        "): " +
        Array.from(byWhy, ([k, v]) => k + "×" + v).join(", "),
    );
  }

  const fail = fivexx.length + bad.length + (STRICT ? nonJson.length : 0);
  console.log("\n[fuzz] done: " + (fail === 0 ? "PASS" : "FAIL(" + fail + ")"));
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("[fuzz] crashed:", e);
  process.exit(2);
});
