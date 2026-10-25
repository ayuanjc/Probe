#!/usr/bin/env node
/**
 * 容量压测：只打不花钱的端点。
 *
 * 为什么不压 /api/search：一次提问 = 2–3 次上游 LLM 调用 + 一次检索，钱的闸在别人手上，
 * 压出来的是「上游多久回」而不是「这台机器能扛多少」。这里是 Node + SSR + nginx 的容量。
 *
 *   BASE=http://127.0.0.1:3215 node scripts/loadtest.mjs
 *   BASE=... CONCURRENCY=40 DURATION_MS=20000 node scripts/loadtest.mjs
 *
 * 输出：每个端点的请求数 / RPS / p50 p95 p99 / 非 2xx。
 */
const BASE = (process.env.BASE || "http://127.0.0.1:3215").replace(/\/$/, "");
const CONCURRENCY = Math.max(1, Math.min(200, Number(process.env.CONCURRENCY) || 20));
const DURATION_MS = Math.max(2000, Math.min(120000, Number(process.env.DURATION_MS) || 15000));
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS) || 20000;

const TARGETS = (process.env.PATHS || "/api/version,/api/region,/login,/,/robots.txt").split(",");

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i];
}

async function one(path) {
  const started = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(BASE + path, { signal: ctrl.signal, redirect: "manual" });
    await res.arrayBuffer();
    return { ms: Date.now() - started, status: res.status };
  } catch (err) {
    return { ms: Date.now() - started, status: 0, err: String(err && err.message ? err.message : err) };
  } finally {
    clearTimeout(timer);
  }
}

async function bench(path) {
  const latencies = [];
  const statuses = new Map();
  let stop = false;
  setTimeout(() => {
    stop = true;
  }, DURATION_MS).unref?.();

  async function worker() {
    while (!stop) {
      const r = await one(path);
      latencies.push(r.ms);
      const key = r.status === 0 ? "abort/error" : String(r.status);
      statuses.set(key, (statuses.get(key) || 0) + 1);
    }
  }

  const workers = Array.from({ length: CONCURRENCY }, () => worker());
  await Promise.all(workers);
  latencies.sort((a, b) => a - b);
  const bad = [...statuses.entries()].filter(([k]) => k !== "200").reduce((n, [, v]) => n + v, 0);
  return {
    path,
    n: latencies.length,
    rps: +(latencies.length / (DURATION_MS / 1000)).toFixed(1),
    p50: percentile(latencies, 50),
    p95: percentile(latencies, 95),
    p99: percentile(latencies, 99),
    max: latencies[latencies.length - 1] || 0,
    bad,
    statuses: Object.fromEntries(statuses),
  };
}

const rows = [];
for (const path of TARGETS) rows.push(await bench(path.trim()));

console.log("base=" + BASE + " concurrency=" + CONCURRENCY + " duration=" + DURATION_MS + "ms");
const pad = (v, n) => String(v).padEnd(n);
console.log(pad("path", 16) + pad("n", 7) + pad("rps", 8) + pad("p50", 7) + pad("p95", 7) + pad("p99", 7) + pad("max", 7) + "非 200");
for (const r of rows) {
  console.log(pad(r.path, 16) + pad(r.n, 7) + pad(r.rps, 8) + pad(r.p50, 7) + pad(r.p95, 7) + pad(r.p99, 7) + pad(r.max, 7) + r.bad + " " + JSON.stringify(r.statuses));
}
