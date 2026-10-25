import test from "node:test";
import assert from "node:assert/strict";
import {
  isPrivateIp,
  normalizeIp,
  parseRegionWord,
  regionFromCountry,
  regionFromHeaders,
  resolveRegionForRequest,
} from "@/lib/region";
import { decideModel, hostAllowed, modelHostOf, regionPolicy, retrievalAllowed } from "@/lib/region-policy";
import {
  prepareRuntimeConfig,
  regionSummary,
  resolvedOpenaiBaseUrl,
  resolvedOpenaiKey,
  resolvedTavilyKey,
  withRuntimeConfig,
} from "@/lib/runtime-config";

/**
 * 区域分流是"合规开关"而不是"体验开关"：判错的后果是把境内用户的查询词发了出去，
 * 收不回来。所以这里钉的是判定与闸门的**行为**，不是实现细节。
 */

function applyEnv(vars: Record<string, string | undefined>) {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
}

function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const restore = applyEnv(vars);
  try {
    return fn();
  } finally {
    restore();
  }
}

/**
 * 异步版本必须等 fn 真的跑完再还原 env：
 * withEnv 的 finally 在 async 函数返回 Promise 的那一刻就执行了，
 * 用它包 await 会把变量提前改回去，测试于是"偶发通过"。
 */
async function withEnvAsync<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const restore = applyEnv(vars);
  try {
    return await fn();
  } finally {
    restore();
  }
}

function req(headers: Record<string, string> = {}): Request {
  return new Request("https://probe.example/api/search", { method: "POST", headers });
}

test("regionFromCountry：中国码→cn，其他国家→intl，无法识别→null（不是猜）", () => {
  assert.equal(regionFromCountry("CN"), "cn");
  assert.equal(regionFromCountry(" chn "), "cn");
  assert.equal(regionFromCountry("SG"), "intl");
  assert.equal(regionFromCountry("DE"), "intl");
  // 这些是 CDN 在"不知道"时真的会吐出来的值，不能被当成某个国家
  for (const u of ["", "XX", "T1", "A1", "A2", "N/A", "UNKNOWN", "-", null, undefined]) {
    assert.equal(regionFromCountry(u), null, String(u));
  }
});

test("parseRegionWord：auto 表示「继续往下判」，而不是固定成默认值", () => {
  assert.equal(parseRegionWord("auto"), null);
  assert.equal(parseRegionWord(""), null);
  assert.equal(parseRegionWord("cn"), "cn");
  assert.equal(parseRegionWord("Mainland"), "cn");
  assert.equal(parseRegionWord("intl"), "intl");
  assert.equal(parseRegionWord("overseas"), "intl");
  assert.equal(parseRegionWord("SG"), "intl");
});

test("regionFromHeaders：x-probe-region 优先，其次才是各家的国家头", () => {
  const hit = regionFromHeaders((n) =>
    n === "x-probe-region" ? "cn" : n === "cf-ipcountry" ? "SG" : null,
  );
  assert.deepEqual(hit, { region: "cn", source: "header" });

  const cf = regionFromHeaders((n) => (n === "cf-ipcountry" ? "SG" : null));
  assert.equal(cf?.region, "intl");
  assert.equal(cf?.country, "SG");

  // 边缘节点吐了 UNKNOWN：等于没给，继续往下判
  assert.equal(regionFromHeaders((n) => (n === "cf-ipcountry" ? "XX" : null)), null);
  assert.equal(regionFromHeaders(() => null), null);
});

test("isPrivateIp：内网与元数据地址没有国家属性", () => {
  for (const ip of ["127.0.0.1", "10.1.2.3", "192.168.1.1", "172.20.0.5", "169.254.169.254", "::1", "direct", ""]) {
    assert.equal(isPrivateIp(ip), true, ip);
  }
  for (const ip of ["8.8.8.8", "106.52.116.164", "203.0.113.9"]) {
    assert.equal(isPrivateIp(ip), false, ip);
  }
});

test("resolveRegionForRequest：显式 mode 胜过一切", async () => {
  await withEnvAsync({ PROBE_REGION_MODE: "cn" }, async () => {
    const hit = await resolveRegionForRequest(req({ "cf-ipcountry": "SG" }));
    assert.deepEqual(hit, { region: "cn", source: "mode" });
  });
});

/**
 * 这一条是安全边界：伪造 X-Forwarded-For 不该换来"境外身份"。
 * 没有可信代理（hops=0）时 clientKey 返回 direct，于是既不查 IP 也不采信头部 IP。
 */
test("resolveRegionForRequest：没有可信代理时，伪造的 X-Forwarded-For 换不来境外", async () => {
  await withEnvAsync(
    {
      PROBE_REGION_MODE: undefined,
      PROBE_DEFAULT_REGION: "cn",
      PROBE_TRUSTED_PROXY_HOPS: "0",
      PROBE_REGION_LOOKUP_URL: "https://lookup.invalid/{ip}",
    },
    async () => {
      const hit = await resolveRegionForRequest(req({ "x-forwarded-for": "8.8.8.8" }));
      assert.deepEqual(hit, { region: "cn", source: "default" });
    },
  );
});

test("regionPolicy：境内是白名单，境外是放行一切", () => {
  const cn = regionPolicy("cn");
  assert.equal(cn.allowAnyModelHost, false);
  assert.equal(hostAllowed("api.deepseek.com", cn), true);
  assert.equal(hostAllowed("api.openai.com", cn), false);
  // 子域也算同一家（网关常写成 api.cn.deepseek.com 这种）
  assert.equal(hostAllowed("gw.api.deepseek.com", cn), true);
  // 内网自建端点本来就没出网
  assert.equal(hostAllowed("127.0.0.1", cn), true);

  const intl = regionPolicy("intl");
  assert.equal(intl.allowAnyModelHost, true);
  assert.equal(hostAllowed("api.openai.com", intl), true);

  assert.deepEqual([...regionPolicy("cn").retrieval], ["bocha"]);
  assert.deepEqual([...regionPolicy("intl").retrieval].sort(), ["bocha", "gdelt", "hn", "tavily", "wiki"]);
  assert.equal(retrievalAllowed("cn", "tavily"), false);
  assert.equal(retrievalAllowed("intl", "tavily"), true);
});

test("modelHostOf：空地址等于官方，这是最容易漏判的一种", () => {
  assert.equal(modelHostOf(undefined), "api.openai.com");
  assert.equal(modelHostOf(""), "api.openai.com");
  assert.equal(modelHostOf("https://api.deepseek.com/v1"), "api.deepseek.com");
  assert.equal(modelHostOf("api.deepseek.com/v1"), "api.deepseek.com");
});

test("decideModel：境内遇到境外端点时，有兜底就切换，没兜底就拦下", () => {
  const noFallback = {
    PROBE_CN_MODEL_KEY: undefined,
    PROBE_CN_MODEL_BASE_URL: undefined,
    PROBE_CN_MODEL_ID: undefined,
  };
  withEnv(noFallback, () => {
    const d = decideModel("cn", { baseUrl: "https://api.openai.com/v1", modelId: "gpt-6-luna" });
    assert.equal(d.kind, "blocked");
    // 境内白名单内的端点照常放行
    assert.equal(decideModel("cn", { baseUrl: "https://api.deepseek.com/v1", modelId: "deepseek-flash" }).kind, "allowed");
    // 境外区域不设白名单
    assert.equal(decideModel("intl", { baseUrl: "https://api.openai.com/v1", modelId: "gpt-6-luna" }).kind, "allowed");
  });

  withEnv(
    {
      PROBE_CN_MODEL_KEY: "sk-aaaaaaaaaaaa",
      PROBE_CN_MODEL_BASE_URL: "https://api.deepseek.com/v1",
      PROBE_CN_MODEL_ID: undefined,
    },
    () => {
      const d = decideModel("cn", { baseUrl: "https://api.openai.com/v1", modelId: "gpt-6-luna" });
      assert.equal(d.kind, "switched");
      if (d.kind !== "switched") return;
      assert.equal(d.host, "api.deepseek.com");
      assert.equal(d.modelId, "deepseek-flash");
      assert.equal(d.from, "api.openai.com");
      // 已经在白名单里就不该"切换"，否则同一个端点会被无谓地改掉
      assert.equal(decideModel("cn", { baseUrl: "https://api.deepseek.com/v1", modelId: "x" }).kind, "allowed");
    },
  );
});

/**
 * 兜底端点自己也得过闸门。否则配一个 api.openai.com 当"境内兜底"，
 * 闸门就成了摆设 —— 这是最容易写错的一行。
 */
test("decideModel：兜底端点不在白名单时，依然拦下", () => {
  withEnv(
    {
      PROBE_CN_MODEL_KEY: "sk-aaaaaaaaaaaa",
      PROBE_CN_MODEL_BASE_URL: "https://api.openai.com/v1",
    },
    () => {
      const d = decideModel("cn", { baseUrl: "https://api.openai.com/v1", modelId: "gpt-6-luna" });
      assert.equal(d.kind, "blocked");
    },
  );
});

test("运行时：境内请求拿不到境外 key，也拿不到境外检索 key", () => {
  withEnv(
    {
      OPENAI_API_KEY: "sk-env-openai-key",
      TAVILY_API_KEY: "tvly-env-key",
      PROBE_CN_MODEL_KEY: undefined,
      PROBE_CN_MODEL_BASE_URL: undefined,
    },
    () => {
      const cn = withRuntimeConfig({ region: "cn" }, () => ({
        key: resolvedOpenaiKey(),
        base: resolvedOpenaiBaseUrl(),
        tavily: resolvedTavilyKey(),
      }));
      assert.deepEqual(cn, { key: undefined, base: undefined, tavily: undefined });

      const intl = withRuntimeConfig({ region: "intl" }, () => ({
        key: resolvedOpenaiKey(),
        tavily: resolvedTavilyKey(),
      }));
      assert.equal(intl.key, "sk-env-openai-key");
      assert.equal(intl.tavily, "tvly-env-key");
    },
  );
});

test("运行时：境内有兜底端点时，key 与地址都被换掉，且模型跟着换", async () => {
  await withEnvAsync(
    {
      OPENAI_API_KEY: "sk-env-openai-key",
      PROBE_CN_MODEL_KEY: "sk-env-cn-key",
      PROBE_CN_MODEL_BASE_URL: "https://api.deepseek.com/v1",
      PROBE_CN_MODEL_ID: "deepseek-flash",
    },
    async () => {
      const got = withRuntimeConfig({ region: "cn", openaiBaseUrl: "https://api.openai.com/v1" }, () => ({
        key: resolvedOpenaiKey(),
        base: resolvedOpenaiBaseUrl(),
      }));
      assert.deepEqual(got, { key: "sk-env-cn-key", base: "https://api.deepseek.com/v1" });
    },
  );
});

/**
 * 设置面板的「当前区域」读的就是 regionSummary()。
 * 它必须能区分「允许」与「被拦」——面板写"境内"却把模型暗中拦下，是另一种撒谎。
 */
test("regionSummary：把区域、来源、模型端点与允许的检索源一并交代清楚", () => {
  const cn = withRuntimeConfig({ region: "cn", regionSource: "header", regionCountry: "CN" }, () =>
    regionSummary(),
  );
  assert.equal(cn.region, "cn");
  assert.equal(cn.source, "header");
  assert.equal(cn.country, "CN");
  assert.equal(cn.modelHost, "api.openai.com", "没配 baseUrl 就等于官方端点");
  assert.equal(cn.modelMode, "blocked", "境内 + 境外端点 + 没有兜底 = 拦下，不能报 allowed");
  assert.deepEqual([...cn.retrieval], ["bocha"]);

  const intl = withRuntimeConfig({ region: "intl" }, () => regionSummary());
  assert.equal(intl.region, "intl");
  assert.equal(intl.modelMode, "allowed");
  assert.ok(intl.retrieval.includes("tavily"));
  assert.equal(intl.country, undefined, "没拿到国家码时不要编一个");
});

test("regionSummary：境内配了兜底端点时，面板显示的是切换后的端点", () => {
  const restore = applyEnv({
    PROBE_CN_MODEL_KEY: "sk-cn-fallback-0001",
    PROBE_CN_MODEL_BASE_URL: "https://api.deepseek.com/v1",
    PROBE_CN_MODEL_ID: "deepseek-flash",
  });
  try {
    const s = withRuntimeConfig({ region: "cn" }, () => regionSummary());
    assert.equal(s.modelMode, "switched");
    assert.equal(s.modelHost, "api.deepseek.com");
  } finally {
    restore();
  }
});

test("regionSummary：属地给中文名，地址只在确实是公网地址时才回显", () => {
  const s = withRuntimeConfig(
    {
      region: "intl",
      regionSource: "ip",
      regionCountry: "SG",
      visitorIp: "203.0.113.9",
      ipScope: "public",
    },
    () => regionSummary(),
  );
  assert.equal(s.country, "SG");
  assert.equal(s.countryName, "新加坡");
  assert.equal(s.ip, "203.0.113.9");
  assert.equal(s.ipScope, "public");

  const local = withRuntimeConfig(
    { region: "cn", regionSource: "default", visitorIp: "127.0.0.1", ipScope: "private" },
    () => regionSummary(),
  );
  assert.equal(local.ip, undefined, "内网地址不是「你的公网 IP」，不要当属地依据回显");
  assert.equal(local.ipScope, "private");
  assert.equal(local.countryName, undefined, "没有国家码时不要编一个中文名");
});

test("prepareRuntimeConfig：来访地址按可信跳数取，直连时如实说取不到", async () => {
  const restore = applyEnv({ PROBE_TRUSTED_PROXY_HOPS: "1" });
  try {
    const behindProxy = new Request("http://127.0.0.1/api/region", {
      headers: { "x-forwarded-for": "198.51.100.7, 203.0.113.9", "x-probe-country": "SG" },
    });
    const cfg = await prepareRuntimeConfig(behindProxy);
    assert.equal(cfg.visitorIp, "203.0.113.9");
    assert.equal(cfg.ipScope, "public");
    assert.equal(cfg.region, "intl");
    assert.equal(cfg.regionCountry, "SG");
  } finally {
    restore();
  }

  const direct = await prepareRuntimeConfig(new Request("http://127.0.0.1/api/region"));
  assert.equal(direct.visitorIp, undefined);
  assert.equal(direct.ipScope, "unknown");
});

test("IPv4-mapped 地址要归一化，否则回环地址会被当成公网地址显示出来", () => {
  assert.equal(normalizeIp("::ffff:127.0.0.1"), "127.0.0.1");
  assert.equal(normalizeIp("[::ffff:203.0.113.9]"), "203.0.113.9");
  assert.equal(normalizeIp("2001:db8::1"), "2001:db8::1");

  assert.equal(isPrivateIp("::ffff:127.0.0.1"), true);
  assert.equal(isPrivateIp("::ffff:192.168.3.4"), true);
  assert.equal(isPrivateIp("::ffff:203.0.113.9"), false);
});
