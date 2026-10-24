import { test } from "node:test";
import { strict as assert } from "node:assert";
import { createGate, createLimiter, readPositiveInt } from "../src/lib/rate-limit";
import {
  clientKey,
  constantTimeEqual,
  isCrossSite,
  readJsonBody,
  stripControlChars,
} from "../src/lib/request-guard";
import { isPrivateAddress, portAllowed } from "../src/lib/http";
import {
  DEFAULT_MODEL_ID,
  cleanBaseUrl,
  configFromRequest,
  modelIsExplicit,
  resolvedModelId,
  resolvedOpenaiBaseUrl,
  withRuntimeConfig,
} from "../src/lib/runtime-config";

/* ---------------------------- 环境变量解析 ---------------------------- */

function withEnv<T>(name: string, value: string | undefined, fn: () => T): T {
  const prev = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env[name];
    else process.env[name] = prev;
  }
}

test("readPositiveInt：没设 / 空串走默认值", () => {
  assert.equal(withEnv("PROBE_TEST_RL", undefined, () => readPositiveInt("PROBE_TEST_RL", 7)), 7);
  assert.equal(withEnv("PROBE_TEST_RL", "   ", () => readPositiveInt("PROBE_TEST_RL", 7)), 7);
});

test("readPositiveInt：非法值回落默认值，不会变成 NaN 把限流静默关掉", () => {
  // 这是修复的核心回归点：旧写法 Number("abc") === NaN，而
  // `recent.length >= NaN` 恒为 false —— 一个笔误的环境变量等于完全不限流。
  for (const bad of ["abc", "0", "-3", "NaN", "Infinity", "1e999"]) {
    const got = withEnv("PROBE_TEST_RL", bad, () => readPositiveInt("PROBE_TEST_RL", 12));
    assert.equal(got, 12, "bad value " + bad);
    assert.ok(Number.isFinite(got));
  }
});

test("readPositiveInt：合法值向下取整且不小于 1，并按 max 夹紧", () => {
  assert.equal(withEnv("PROBE_TEST_RL", "8.9", () => readPositiveInt("PROBE_TEST_RL", 1)), 8);
  assert.equal(withEnv("PROBE_TEST_RL", "0.5", () => readPositiveInt("PROBE_TEST_RL", 1)), 1);
  assert.equal(withEnv("PROBE_TEST_RL", "9999", () => readPositiveInt("PROBE_TEST_RL", 1, { max: 100 })), 100);
});

/* ------------------------------ 限流器 ------------------------------ */

test("createLimiter：窗口内达到上限即拒绝，并给出 Retry-After", () => {
  const lim = createLimiter({ name: "t", limit: 3 });
  assert.deepEqual(
    [lim.check("a").ok, lim.check("a").ok, lim.check("a").ok],
    [true, true, true],
  );
  const blocked = lim.check("a");
  assert.equal(blocked.ok, false);
  assert.ok(blocked.retryAfterSeconds >= 1);
  // 不同键互不影响
  assert.equal(lim.check("b").ok, true);
});

test("createLimiter：过期之后重新放行", async () => {
  const lim = createLimiter({ name: "t", limit: 1, windowMs: 1_000 });
  assert.equal(lim.check("a").ok, true);
  assert.equal(lim.check("a").ok, false);
  await new Promise((r) => setTimeout(r, 1_050));
  assert.equal(lim.check("a").ok, true);
});

test("createLimiter：键表有上限，伪造海量键也撑不爆内存", () => {
  const lim = createLimiter({ name: "t", limit: 2, maxKeys: 32 });
  for (let i = 0; i < 5_000; i++) lim.check("k" + i);
  assert.ok(lim.size() <= 32, "size=" + lim.size());
});

test("createGate：并发上限之外拿不到槽位，释放后可再拿", () => {
  const gate = createGate(2);
  const a = gate.acquire();
  const b = gate.acquire();
  assert.ok(a && b);
  assert.equal(gate.acquire(), null);
  assert.equal(gate.active, 2);
  a!();
  a!(); // 重复释放不该把计数打成负数
  assert.equal(gate.active, 1);
  const c = gate.acquire();
  assert.ok(c);
  b!();
  c!();
  assert.equal(gate.active, 0);
});

/* --------------------------- 客户端来源识别 --------------------------- */

function req(headers: Record<string, string>, method = "GET"): Request {
  return new Request("http://127.0.0.1:3215/probe/api/search", { method, headers });
}

test("clientKey：默认只信任一层代理，取 X-Forwarded-For 最右一项", () => {
  withEnv("PROBE_TRUSTED_PROXY_HOPS", undefined, () => {
    // 攻击者能自己塞左边的值（$proxy_add_x_forwarded_for 只在右边追加），
    // 所以真实 IP 必须从右往左数，而不是取第一个。
    const key = clientKey(req({ "x-forwarded-for": "1.1.1.1, 203.0.113.9" }));
    assert.equal(key, "203.0.113.9");
  });
});

test("clientKey：两跳时取右起第二项", () => {
  withEnv("PROBE_TRUSTED_PROXY_HOPS", "2", () => {
    assert.equal(clientKey(req({ "x-forwarded-for": "1.1.1.1, 203.0.113.9" })), "1.1.1.1");
  });
});

test("clientKey：hops=0（前面没有代理）时彻底忽略转发头", () => {
  withEnv("PROBE_TRUSTED_PROXY_HOPS", "0", () => {
    const key = clientKey(req({ "x-forwarded-for": "8.8.8.8", "x-real-ip": "9.9.9.9" }));
    assert.equal(key, "direct");
  });
});

test("clientKey：转发头缺失时回落 X-Real-IP，再不行回落共享键", () => {
  withEnv("PROBE_TRUSTED_PROXY_HOPS", undefined, () => {
    assert.equal(clientKey(req({ "x-real-ip": "198.51.100.7" })), "198.51.100.7");
    assert.equal(clientKey(req({})), "direct");
  });
});

test("clientKey：脏 header 被清洗，且长度有界（防止用超长 header 撑大键表）", () => {
  withEnv("PROBE_TRUSTED_PROXY_HOPS", undefined, () => {
    // undici 会在 new Request() 阶段就拒掉含 NUL 的 header，所以这里用
    // 「超长 + 各种非法字符」模拟脏值；NUL 的清洗交给 stripControlChars 用例。
    const junk = "A".repeat(4_000) + "<script> ";
    const key = clientKey(req({ "x-forwarded-for": junk }));
    assert.ok(key.length <= 64, "len=" + key.length);
    assert.ok(!/[<>\u0000]/.test(key));
  });
});

/* ------------------------------ 跨站判定 ------------------------------ */

test("isCrossSite：Sec-Fetch-Site 与 Origin 两种信号都认", () => {
  assert.equal(isCrossSite(req({ "sec-fetch-site": "cross-site" })), true);
  assert.equal(isCrossSite(req({ "sec-fetch-site": "same-origin" })), false);
  assert.equal(
    isCrossSite(req({ host: "probe.example", origin: "https://evil.example" })),
    true,
  );
  assert.equal(
    isCrossSite(req({ host: "probe.example", origin: "https://probe.example" })),
    false,
  );
  // Origin: null（沙箱 iframe / file://）算跨站
  assert.equal(isCrossSite(req({ host: "probe.example", origin: "null" })), true);
  // 无任何信号的命令行调用放行
  assert.equal(isCrossSite(req({})), false);
});

/* ------------------------------ 请求体 ------------------------------ */

test("readJsonBody：正常 JSON 通过", async () => {
  const r = await readJsonBody(
    new Request("http://x/y", { method: "POST", body: JSON.stringify({ a: 1 }) }),
    1_000,
  );
  assert.equal(r.ok, true);
  if (r.ok) assert.deepEqual(r.value, { a: 1 });
});

test("readJsonBody：超过上限直接 413，不把超大 body 读进内存", async () => {
  const big = JSON.stringify({ pad: "x".repeat(50_000) });
  const r = await readJsonBody(new Request("http://x/y", { method: "POST", body: big }), 1_000);
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.status, 413);
});

test("readJsonBody：非法 JSON 与空体都是 400，且不回显原文", async () => {
  const bad = await readJsonBody(new Request("http://x/y", { method: "POST", body: "{oops" }), 1_000);
  assert.equal(bad.ok, false);
  if (!bad.ok) {
    assert.equal(bad.status, 400);
    assert.equal(bad.code, "bad_json");
    assert.ok(!bad.message.includes("oops"));
  }
  const empty = await readJsonBody(new Request("http://x/y", { method: "POST" }), 1_000);
  assert.equal(empty.ok, false);
});

/* --------------------------- 常量时间比较 --------------------------- */

test("constantTimeEqual：相同为真，不同 / 空值为假", () => {
  const secret = "a".repeat(32);
  assert.equal(constantTimeEqual(secret, secret), true);
  assert.equal(constantTimeEqual("a".repeat(31), secret), false);
  assert.equal(constantTimeEqual("b".repeat(32), secret), false);
  assert.equal(constantTimeEqual(null, secret), false);
  assert.equal(constantTimeEqual(secret, undefined), false);
  assert.equal(constantTimeEqual("", ""), false);
});

/* --------------------------- 日志控制字符 --------------------------- */

test("stripControlChars：ANSI 转义被剥掉（防止 tail 时终端被注入）", () => {
  const raw = "正常\u001b[2J\u001b[31m红\u0007\u0000结尾";
  const out = stripControlChars(raw);
  assert.ok(!out.includes("\u001b"));
  assert.ok(!out.includes("\u0007"));
  assert.ok(!out.includes("\u0000"));
  assert.ok(out.includes("正常") && out.includes("结尾"));
});

/* ------------------------- 出站抓取：地址与端口 ------------------------- */

test("isPrivateAddress：回环与内网的各种写法都要拦住", () => {
  const blocked = [
    "127.0.0.1",
    "10.1.2.3",
    "169.254.169.254", // 云元数据
    "192.168.1.1",
    "::1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "fe80::1",
    "fd00::1",
    "0.0.0.0",
  ];
  for (const ip of blocked) assert.equal(isPrivateAddress(ip), true, ip);
});

test("isPrivateAddress：公网地址放行", () => {
  for (const ip of ["1.1.1.1", "93.184.216.34", "2606:4700::1111"]) {
    assert.equal(isPrivateAddress(ip), false, ip);
  }
});

test("portAllowed：默认只允许 80/443，端口越权不被当作文章地址", () => {
  withEnv("PROBE_FETCH_ALLOWED_PORTS", undefined, () => {
    assert.equal(portAllowed(80), true);
    assert.equal(portAllowed(443), true);
    assert.equal(portAllowed(22), false);
    assert.equal(portAllowed(6379), false);
    assert.equal(portAllowed(9200), false);
  });
});

/* ------------------------ 用户自填的模型接口地址 ------------------------ */

test("cleanBaseUrl：合法地址规范化（去尾斜杠、去 query / userinfo）", () => {
  const cases: [string, string | undefined][] = [
    ["https://api.deepseek.com/v1", "https://api.deepseek.com/v1"],
    ["https://api.deepseek.com/v1/", "https://api.deepseek.com/v1"],
    ["https://api.deepseek.com/v1///", "https://api.deepseek.com/v1"],
    ["  https://open.bigmodel.cn/api/paas/v4  ", "https://open.bigmodel.cn/api/paas/v4"],
    ["https://api.openai.com/v1?debug=1", "https://api.openai.com/v1"],
    ["https://api.openai.com/v1#frag", "https://api.openai.com/v1"],
    ["http://127.0.0.1:11434/v1", "http://127.0.0.1:11434/v1"],
  ];
  for (const [input, want] of cases) assert.equal(cleanBaseUrl(input), want, input);
});

test("cleanBaseUrl：非 http(s)、缺 scheme、带空白、元数据地址一律当没填", () => {
  const bad = [
    "ftp://api.example.com/v1",
    "file:///etc/passwd",
    "javascript:alert(1)",
    "api.deepseek.com/v1", // 缺 scheme
    "",
    "https://a.co/v1 extra",
    "http://169.254.169.254/latest/meta-data",
    "https://metadata.google.internal/",
    "https://a.b", // 少于 12 字符
  ];
  for (const v of bad) assert.equal(cleanBaseUrl(v), undefined, v);
});

test("resolvedOpenaiBaseUrl / resolvedModelId：面板值优先于环境变量", () => {
  withEnv("OPENAI_BASE_URL", "https://api.siliconflow.cn/v1/", () => {
    withEnv("PROBE_MODEL", "env-model", () => {
      assert.equal(resolvedOpenaiBaseUrl(), "https://api.siliconflow.cn/v1");
      assert.equal(resolvedModelId(), "env-model");
      assert.equal(modelIsExplicit(), true);

      withRuntimeConfig(
        { openaiBaseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat" },
        () => {
          assert.equal(resolvedOpenaiBaseUrl(), "https://api.deepseek.com/v1");
          assert.equal(resolvedModelId(), "deepseek-chat");
        },
      );
    });
  });
  withEnv("OPENAI_BASE_URL", undefined, () => {
    withEnv("PROBE_MODEL", undefined, () => {
      assert.equal(resolvedOpenaiBaseUrl(), undefined);
      assert.equal(resolvedModelId(), DEFAULT_MODEL_ID);
      assert.equal(modelIsExplicit(), false);
    });
  });
});

test("configFromRequest：三个头一起到达时才进运行时配置，脏地址被丢掉", () => {
  const good = new Request("http://x.test/api/search", {
    headers: {
      "x-probe-openai-key": "sk-test-1234567890",
      "x-probe-openai-base-url": "https://api.deepseek.com/v1/",
      "x-probe-model": "deepseek-chat",
    },
  });
  const cfg = configFromRequest(good);
  assert.equal(cfg.openaiBaseUrl, "https://api.deepseek.com/v1");
  assert.equal(cfg.model, "deepseek-chat");

  const bad = new Request("http://x.test/api/search", {
    headers: { "x-probe-openai-key": "sk-test-1234567890", "x-probe-openai-base-url": "ftp://nope" },
  });
  assert.equal(configFromRequest(bad).openaiBaseUrl, undefined);
});

