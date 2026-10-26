/**
 * 运行时计数：这些数字是运维唯一能回答「今天有人在用吗、降级最多的是哪一类」的东西，
 * 所以断言要盯住两件事 —— 计数不能丢（少记比多记危险），脏数据不能让面板崩。
 */
import test from "node:test";
import assert from "node:assert/strict";

import { __testResetCounters, countersSnapshot, normalizeReason, recordDegraded, recordOp } from "@/lib/ops-counters";
import { buildOpsReport } from "@/lib/ops-report";

test("recordOp：按次数降序，同次数按名字排", () => {
  __testResetCounters();
  recordOp("search");
  recordOp("search");
  recordOp("verify");
  const snap = countersSnapshot();
  assert.deepEqual(snap.ops.map((r) => r.name + "=" + r.count), ["search=2", "verify=1"]);
  // 空格/空串不能变成一条计数
  recordOp("  ");
  assert.equal(countersSnapshot().ops.length, 2);
});

test("normalizeReason：实例编号与变化记录折成同一类，不能一条一个键", () => {
  assert.equal(normalizeReason("claims:quote_miss_3"), "claims:quote_miss");
  assert.equal(normalizeReason("claims:quote_miss_12"), "claims:quote_miss");
  assert.equal(normalizeReason("region:model_switched:api.openai.com->api.deepseek.com"), "region:model_switched");
  assert.equal(normalizeReason("wiki:failed"), "wiki:failed");
  assert.equal(normalizeReason("region:model_blocked:api.openai.com"), "region:model_blocked");
  // 非字符串/空串不进统计
  assert.equal(normalizeReason(42), null);
  assert.equal(normalizeReason("   "), null);
  assert.equal(normalizeReason(null), null);
});

test("recordDegraded：总数把每一条原因都算上（去重后按类别计）", () => {
  __testResetCounters();
  recordDegraded(["claims:quote_miss_1", "claims:quote_miss_2", "bocha:quota", null, 42]);
  const snap = countersSnapshot();
  assert.equal(snap.degradedTotal, 3);
  assert.deepEqual(snap.degraded.map((r) => r.reason + "=" + r.count), ["claims:quote_miss=2", "bocha:quota=1"]);
  // 空数组/缺省不该翻出任何东西
  recordDegraded([]);
  recordDegraded(undefined);
  assert.equal(countersSnapshot().degradedTotal, 3);
});

test("类别超过上限时并进 other，但总条数一条都不许少", () => {
  __testResetCounters();
  const many: string[] = [];
  for (let i = 0; i < 80; i += 1) many.push("src" + i + ":why" + i);
  recordDegraded(many);
  const snap = countersSnapshot();
  // 总数必须完整：显示可以截断，"今天降级了多少次"不能。
  assert.equal(snap.degradedTotal, 80);
  const sum = snap.degraded.reduce((acc, r) => acc + r.count, 0);
  assert.ok(sum <= 80 && sum > 0, "列表只留前 40 类，加起来不该超过总数");
  assert.ok(snap.degraded.some((r) => r.reason === "other"), "超出上限的应并入 other");
  assert.ok(snap.degraded.length <= 40);
});

test("countersSnapshot 的 day 是 YYYY-MM-DD", () => {
  __testResetCounters();
  assert.match(countersSnapshot().day, /^\d{4}-\d{2}-\d{2}$/);
});

test("buildOpsReport：计数原样透传，脏数据不会让面板 500", () => {
  __testResetCounters();
  recordOp("search");
  recordDegraded(["bocha:quota"]);
  const base = {
    now: 1_700_000_000_000,
    day: "2026-10-26",
    quota: {
      globalCap: 800,
      globalUsed: 10,
      perUserCap: 60,
      globalFrom: "env" as const,
      perUserFrom: "env" as const,
      exhausted: false,
      keySource: "env" as const,
      modelEnabled: true,
    },
    users: [{ id: "u1", username: "ayuan" }],
    scopes: [{ key: "u:u1", used: 4, calls: 9 }],
    model: { id: "deepseek-flash", host: "api.deepseek.com", mode: "allowed" as const, explicit: true },
    region: { value: "cn" as const, source: "header", fallback: "cn" as const, retrieval: ["bocha"] },
    retrieval: [],
    site: { url: null, icp: null, police: null, operator: null, contact: null },
    guards: { authMode: "on" },
  };
  const good = buildOpsReport({ ...base, counters: countersSnapshot() });
  assert.deepEqual(good.counters.ops.map((r) => r.name + "=" + r.count), ["search=1"]);
  assert.equal(good.counters.degradedTotal, 1);
  assert.match(good.counters.day, /^\d{4}-\d{2}-\d{2}$/);

  const dirty = buildOpsReport({
    ...base,
    counters: {
      day: 123 as unknown as string,
      ops: [{ name: 1, count: 2 }, { name: "search", count: Number.NaN }] as unknown as { name: string; count: number }[],
      degraded: [{ reason: null, count: 1 }] as unknown as { reason: string; count: number }[],
      degradedTotal: Number.POSITIVE_INFINITY,
    },
  });
  assert.equal(dirty.counters.day, "");
  assert.equal(dirty.counters.ops.length, 1);
  assert.equal(dirty.counters.ops[0].count, 0);
  assert.equal(dirty.counters.degraded.length, 0);
  assert.equal(dirty.counters.degradedTotal, 0);
  // 不传 counters 的老调用方也要有形状
  assert.deepEqual(buildOpsReport(base).counters.ops, []);
});
