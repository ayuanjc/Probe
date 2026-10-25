import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  CONSENT_COOKIE,
  CONSENT_MAX_AGE_SECONDS,
  CONSENT_MIN_READ_MS,
  consentCookiePath,
  consentCookieValue,
  consentIsCurrent,
  parseConsentCookie,
} from "../src/lib/consent";
import { consentLogFile, recordConsent } from "../src/lib/consent-log";

/**
 * 同意凭据的测试重点不是「能不能跑通」，而是**任何畸形输入都必须被当成没同意**。
 * 一个能靠手写 cookie 蒙混过去的版本校验，等于把 10 秒强制阅读变成一句文案。
 */

const NOW = Date.UTC(2026, 9, 25, 3, 0, 0);

/**
 * 版本号现在是正文哈希（lib/legal/version.ts 算的），不归 consent.ts 管。
 * 这里用一个固定值代替，测的是「存/取/判」这条链路，哈希本身另有 legal-version.test.ts。
 */
const VERSION = "9f2c1ab7d3e0";

test("consentCookieValue 的形状是 版本.毫秒", () => {
  const value = consentCookieValue(VERSION, NOW);
  assert.equal(value, VERSION + "." + NOW);
  assert.match(value, /^[0-9A-Za-z.-]+\.[0-9]{13}$/);
});

test("parseConsentCookie 能还原版本与时间并判定为现行", () => {
  const parsed = parseConsentCookie(consentCookieValue(VERSION, NOW));
  assert.ok(parsed);
  assert.equal(parsed.version, VERSION);
  assert.equal(parsed.at, NOW);
  assert.equal(consentIsCurrent(parsed, VERSION), true);
  assert.equal(consentIsCurrent(parsed, "000000000000"), false);
});

test("旧版本的同意不再有效（协议改版必须重新确认）", () => {
  const parsed = parseConsentCookie("2020-01-01.1." + NOW);
  assert.ok(parsed);
  assert.equal(parsed.version, "2020-01-01.1");
  assert.equal(consentIsCurrent(parsed, VERSION), false);
});

test("畸形 cookie 一律当成没同意，且不抛异常", () => {
  const bad = [
    "",
    "   ",
    "noversion",
    ".",
    ".1760000000000",
    VERSION + ".",
    VERSION + ".abc",
    VERSION + ".1760000000000; probe_session=abc",
    "x".repeat(80) + ".1760000000000",
    // 时间戳明显不合常理：2019 年之前 / 2100 年之后
    VERSION + ".1000000000000",
    VERSION + ".9999999999999",
  ];
  for (const raw of bad) {
    assert.equal(parseConsentCookie(raw), null, "应当被拒绝: " + JSON.stringify(raw));
    assert.equal(consentIsCurrent(parseConsentCookie(raw), VERSION), false);
  }
  assert.equal(parseConsentCookie(null), null);
  assert.equal(parseConsentCookie(undefined), null);
});

test("cookie 名与有效期的常量不能被悄悄改小", () => {
  assert.equal(CONSENT_COOKIE, "probe_consent");
  assert.ok(CONSENT_MAX_AGE_SECONDS >= 30 * 24 * 60 * 60, "同意有效期至少一个月");
  assert.ok(CONSENT_MIN_READ_MS >= 10_000, "强制阅读不得少于 10 秒");
});

test("consentCookiePath 至少是 /，且不会带尾斜杠", () => {
  const before = process.env.NEXT_PUBLIC_PROBE_BASE_PATH;
  try {
    delete process.env.NEXT_PUBLIC_PROBE_BASE_PATH;
    assert.equal(consentCookiePath(), "/");
    process.env.NEXT_PUBLIC_PROBE_BASE_PATH = "/probe/";
    assert.equal(consentCookiePath(), "/probe");
    process.env.NEXT_PUBLIC_PROBE_BASE_PATH = "";
    assert.equal(consentCookiePath(), "/");
  } finally {
    if (before === undefined) delete process.env.NEXT_PUBLIC_PROBE_BASE_PATH;
    else process.env.NEXT_PUBLIC_PROBE_BASE_PATH = before;
  }
});

test("recordConsent 落盘的是地址指纹，不含明文 IP", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "probe-consent-"));
  const before = process.env.PROBE_DATA_DIR;
  process.env.PROBE_DATA_DIR = dir;
  try {
    assert.equal(consentLogFile(), path.join(dir, "consent", "consent.log"));
    await recordConsent({
      version: VERSION,
      msRead: 12_345,
      ip: "203.0.113.7",
      userAgent: "Mozilla/5.0 (test)",
    });
    const file = consentLogFile();
    assert.ok(existsSync(file), "日志文件应被创建");
    const text = readFileSync(file, "utf8");
    assert.ok(!text.includes("203.0.113.7"), "不得写入明文 IP");
    const line = JSON.parse(text.trim().split("\n")[0]);
    assert.equal(line.version, VERSION);
    assert.equal(line.msRead, 12345);
    assert.match(String(line.ip), /^[0-9a-f]{16}$/);
    assert.match(String(line.at), /^\d{4}-\d{2}-\d{2}T/);
  } finally {
    if (before === undefined) delete process.env.PROBE_DATA_DIR;
    else process.env.PROBE_DATA_DIR = before;
  }
});

test("recordConsent 不因数据目录不可写而抛错", async () => {
  const before = process.env.PROBE_DATA_DIR;
  // 指向一个非法路径：目录创建会失败，函数只 warn，不应把调用方炸掉
  process.env.PROBE_DATA_DIR = path.join(tmpdir(), "probe-consent-null\u0000bad");
  try {
    await recordConsent({ version: VERSION, msRead: 20_000 });
  } finally {
    if (before === undefined) delete process.env.PROBE_DATA_DIR;
    else process.env.PROBE_DATA_DIR = before;
  }
});