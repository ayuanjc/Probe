/**
 * 服务端错误账本：只记 5xx、只记公共文案、环有上限、面板不因脏数据 500。
 *
 * 这一份的意义是「运维先看哪里」：真正的原因在 journald，但后台要能先判断
 * 「是不是同一类错误在反复冒」，否则修完 nginx 还得先 ssh 上去 grep。
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  __testResetErrors,
  errorCounters,
  errorTotal,
  recentErrors,
  recordError,
} from "@/lib/error-log";
import { jsonError } from "@/lib/request-guard";
import { buildOpsReport } from "@/lib/ops-report";

test("只记 5xx：4xx 是调用方的问题，混进来会把信号淹掉", async () => {
  __testResetErrors();
  const res = jsonError(400, "bad_json", "请求体不是合法 JSON。");
  assert.equal(res.status, 400);
  assert.equal(errorTotal(), 0);
  assert.equal(recentErrors().length, 0);

  jsonError(503, "busy", "服务正忙，请稍后再试。");
  assert.equal(errorTotal(), 1);
  assert.equal(recentErrors()[0].code, "busy");
});

test("环有上限，最新的在前，文案截断到 300 字", () => {
  __testResetErrors();
  // 编号放前面：截断的是尾巴，这样才能验出「最新那条在最前」
  for (let i = 0; i < 250; i += 1) recordError({ status: 500, code: "internal", message: "m" + i + "-" + "x".repeat(500) });
  assert.equal(errorTotal(), 250);
  const recent = recentErrors(1000);
  // 上限 200，而且 old_string 那批被丢掉了
  assert.equal(recent.length, 200);
  assert.equal(recent[0].message.startsWith("m249-"), true);
  assert.equal(recent[0].message.length, 300);
  // 内部计数不因环满而回退
  assert.equal(errorCounters()[0].code, "internal");
  assert.equal(errorCounters()[0].count, 200);
});

test("归属缺省是「无主」，byCode 按次数降序", () => {
  __testResetErrors();
  recordError({ status: 500, code: "upstream_error", message: "上游超时" });
  recordError({ status: 502, code: "upstream_error", message: "上游 502" });
  recordError({ status: 500, code: "internal", message: "意外" });
  const top = errorCounters();
  assert.deepEqual(top[0], { code: "upstream_error", count: 2 });
  assert.equal(top[1].code, "internal");
  assert.equal(recentErrors()[0].scope, "无主");
});

test("面板透传错误账本，且脏数据不会让面板 500", () => {
  __testResetErrors();
  recordError({ status: 500, code: "internal", message: "意外" });
  const base = {
    now: Date.UTC(2026, 9, 25),
    day: "2026-10-25",
    quota: {
      globalCap: 800,
      globalUsed: 1,
      perUserCap: 60,
      globalFrom: "env" as const,
      perUserFrom: "env" as const,
      exhausted: false,
      keySource: "env" as const,
      modelEnabled: true,
    },
    users: [],
    scopes: [],
    model: { id: "m", host: "api.deepseek.com", mode: "allowed" as const, explicit: true },
    region: { value: "cn" as const, source: "default", fallback: "cn" as const, retrieval: [] },
    retrieval: [],
    site: { url: null, icp: null, police: null, operator: null, contact: null },
    guards: { authMode: "on" },
  };

  const clean = buildOpsReport({ ...base, errors: { total: errorTotal(), byCode: errorCounters(), recent: recentErrors() } });
  assert.equal(clean.errors.total, 1);
  assert.equal(clean.errors.recent[0].code, "internal");

  // 脏数据：status NaN、scope 不是字符串、code 不是字符串的条目被丢掉
  const dirty = buildOpsReport({
    ...base,
    errors: {
      total: Number.NaN,
      byCode: [{ code: "internal", count: Number.NaN }],
      recent: [
        { at: Number.NaN, scope: 42 as unknown as string, status: Number.NaN, code: "internal", message: "x" },
        { at: 0, scope: "z", status: 500, code: 5 as unknown as string, message: "y" },
      ],
    },
  });
  assert.equal(dirty.errors.total, 0);
  assert.equal(dirty.errors.byCode[0].count, 0);
  assert.equal(dirty.errors.recent.length, 1);
  assert.equal(dirty.errors.recent[0].status, 500);
  assert.equal(dirty.errors.recent[0].scope, "无主");
});
