import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildOpsReport, type RetrievalRow } from "@/lib/ops-report";
import {
  __testReloadQuotaOverrides,
  __testResetGlobalBudget,
  dailyCallBudget,
  perUserUnitBudget,
  quotaLimits,
  setQuotaLimits,
} from "@/lib/llm";

const NO_RETRIEVAL: RetrievalRow[] = [];

/** 输入侧的额度块（注意与 OpsReport.quota 的输出形状不同，别拿报告去 spread）。 */
const QUOTA_IN = {
  globalCap: 2000,
  globalUsed: 500,
  perUserCap: 120,
  globalFrom: "env",
  perUserFrom: "env",
  exhausted: false,
  keySource: "env",
  modelEnabled: true,
} as const;

function base(over: Partial<Parameters<typeof buildOpsReport>[0]> = {}) {
  return buildOpsReport({
    now: 1_700_000_000_000,
    day: "2026-10-25",
    quota: { ...QUOTA_IN },
    users: [
      { id: "u1", username: "alice" },
      { id: "u2", username: "bob" },
    ],
    scopes: [],
    model: { id: "m", host: "api.deepseek.com", mode: "allowed", explicit: true },
    region: { value: "cn", source: "ip", fallback: "cn", retrieval: ["bocha"] },
    retrieval: NO_RETRIEVAL,
    site: { url: null, icp: null, police: null, operator: null, contact: null },
    guards: { authMode: "on" },
    ...over,
  });
}

test("后台额度：用量超过上限时剩余按 0 报，不出现负数", () => {
  const r = base({ quota: { ...QUOTA_IN, globalUsed: 9999 } });
  // 通过 scopes 让 alice 用掉 25 次，上限只有 10
  const withUse = base({ quota: { ...QUOTA_IN, perUserCap: 10 }, scopes: [{ key: "u:u1", used: 25 }] });
  const alice = withUse.quota.users.find((u) => u.username === "alice");
  assert.equal(alice?.used, 25);
  assert.equal(alice?.remaining, 0);
  assert.equal(alice?.ratio, 1);
  assert.equal(r.quota.global.remaining, 0);
  assert.equal(r.quota.global.ratio, 1);
});

test("后台额度：没绑定账号的调用单独记账，不并进任何用户", () => {
  const r = base({ scopes: [{ key: "cron", used: 7 }, { key: "u:u2", used: 3 }] });
  assert.equal(r.quota.unassigned, 7);
  const bob = r.quota.users.find((u) => u.username === "bob");
  const alice = r.quota.users.find((u) => u.username === "alice");
  assert.equal(bob?.used, 3);
  assert.equal(alice?.used, 0);
});

test("后台额度：账号按用量降序，同量按用户名稳定排序", () => {
  const r = base({
    users: [
      { id: "u1", username: "zoe" },
      { id: "u2", username: "amy" },
      { id: "u3", username: "bob" },
    ],
    scopes: [{ key: "u:u1", used: 5 }, { key: "u:u2", used: 5 }, { key: "u:u3", used: 9 }],
  });
  assert.deepEqual(r.quota.users.map((u) => u.username), ["bob", "amy", "zoe"]);
});

test("后台额度：坏数据（负用量 / 非数字上限）不会把面板打成 500", () => {
  const r = buildOpsReport({
    now: 1,
    day: "2026-10-25",
    quota: {
      globalCap: Number.NaN,
      globalUsed: -5,
      perUserCap: Number.NaN,
      globalFrom: "env",
      perUserFrom: "env",
      exhausted: false,
      keySource: "none",
      modelEnabled: false,
    },
    users: [{ id: "u1", username: "alice" }],
    scopes: [{ key: "u:u1", used: Number.NaN }],
    model: { id: "m", host: "h", mode: "blocked", explicit: false },
    region: { value: "cn", source: "default", fallback: "cn", retrieval: [] },
    retrieval: [],
    site: { url: null, icp: null, police: null, operator: null, contact: null },
    guards: { authMode: "on" },
  });
  assert.equal(r.quota.global.cap, 0);
  assert.equal(r.quota.global.used, 0);
  assert.equal(r.quota.users[0].used, 0);
  // 上限 0 时按「已经不能用」算满，进度条不该显示为空
  assert.equal(r.quota.users[0].ratio, 1);
});

/* ---------------------- 额度覆盖的落盘与回落 ---------------------- */

function withTempDataDir<T>(fn: () => T): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "probe-ops-"));
  const prev = process.env.PROBE_DATA_DIR;
  process.env.PROBE_DATA_DIR = dir;
  __testReloadQuotaOverrides();
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.PROBE_DATA_DIR;
    else process.env.PROBE_DATA_DIR = prev;
    __testReloadQuotaOverrides();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("额度覆盖：后台设的上限优先于环境变量，并写进 .data/ops/limits.json", () => {
  withTempDataDir(() => {
    const before = quotaLimits();
    setQuotaLimits({ globalCap: 40, perUserCap: 7 });
    assert.equal(dailyCallBudget(), 40);
    assert.equal(perUserUnitBudget(), 7);
    const after = quotaLimits();
    assert.equal(after.globalFrom, "ui");
    assert.equal(after.perUserFrom, "ui");

    const file = path.join(process.env.PROBE_DATA_DIR as string, "ops", "limits.json");
    const saved = JSON.parse(fs.readFileSync(file, "utf8")) as { globalCap: number; perUserCap: number };
    assert.equal(saved.globalCap, 40);
    assert.equal(saved.perUserCap, 7);

    // 清掉覆盖 → 回到 env / 默认值
    setQuotaLimits({ globalCap: null, perUserCap: null });
    const cleared = quotaLimits();
    assert.equal(cleared.globalFrom, "env");
    assert.equal(cleared.perUserCap, before.perUserCap);
  });
});

test("额度覆盖：0 / 负数 / 小数 / 超界一律当没设，额度不会被改成 0", () => {
  withTempDataDir(() => {
    setQuotaLimits({ globalCap: 0, perUserCap: -1 });
    assert.equal(quotaLimits().globalFrom, "env");
    setQuotaLimits({ globalCap: 3.5, perUserCap: 10 ** 9 });
    assert.equal(quotaLimits().perUserFrom, "env");
    assert.ok(perUserUnitBudget() >= 1);
  });
});

test("额度覆盖：文件被手改坏时回落到环境变量，而不是把全站额度归零", () => {
  withTempDataDir(() => {
    setQuotaLimits({ globalCap: 50, perUserCap: 5 });
    const file = path.join(process.env.PROBE_DATA_DIR as string, "ops", "limits.json");
    fs.writeFileSync(file, "{ 这不是 JSON");
    __testReloadQuotaOverrides();
    const after = quotaLimits();
    assert.equal(after.globalFrom, "env");
    assert.equal(after.perUserFrom, "env");
    assert.ok(after.globalCap > 0);
  });
});

test("额度覆盖：只改其中一条时，另一条不会被顺手清掉", () => {
  withTempDataDir(() => {
    setQuotaLimits({ globalCap: 300, perUserCap: 30 });
    const current = quotaLimits();
    // 模拟路由的「缺省字段带当前值」逻辑
    setQuotaLimits({
      globalCap: 400,
      perUserCap: current.perUserFrom === "ui" ? current.perUserCap : null,
    });
    assert.equal(dailyCallBudget(), 400);
    assert.equal(perUserUnitBudget(), 30);
    setQuotaLimits({ globalCap: null, perUserCap: null });
    __testResetGlobalBudget();
  });
});
