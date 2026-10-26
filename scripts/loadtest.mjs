#!/usr/bin/env node
/**
 * 容量压测 v2：在 v1 基础上加「每秒时间序列」与 cookie。
 *
 * 为什么需要时间序列：单进程 Node 是单线程事件循环，定时任务（cron/heat，每轮
 * 3 秒多的 JSON 解析 + SQLite 写入）会和 SSR 抢同一个线程。平均值看不出来，
 * p99 也不一定 —— 尖刺只有一两秒宽，会被分位数抹平。按秒切窗才看得见。
 *
 *   BASE=http://127.0.0.1:3215 PATHS=/login CONCURRENCY=20 DURATION_MS=60000 SERIES=1 \
 *     /opt/node/bin/node scripts/loadtest.mjs
 *
 * 输出：
 *   summary  path / n / rps / p50 p95 p99 max / 非 200
 *   series（SERIES=1）  每秒 t=n rps p95 max
 */
const BASE = (process.env.BASE || "http://127.0.0.1:3215").replace(/\/$/, "");
const CONCURRENCY = Math.max(1, Math.min(200, Number(process.env.CONCURRENCY) || 20));
const DURATION_MS = Math.max(2000, Math.min(180000, Number(process.env.DURATION_MS) || 15000));
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS) || 20000;
const SERIES = process.env.SERIES === "1";
const COOKIE = process.env.COOKIE || "";
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
  const headers = COOKIE ? { cookie: COOKIE } : undefined;
  try {
    const res = await fetch(BASE + path, { signal: ctrl.signal, redirect: "manual", headers });
    await res.arrayBuffer();
    return { ms: Date.now() - started, status: res.status, t: started };
  } catch (err) {
    return { ms: Date.now() - started, status: 0, t: started, err: String(err && err.message ? err.message : err) };
  } finally {
    clearTimeout(timer);
  }
}

async function bench(path) {
  const samples = [];
  const statuses = new Map();
  const t0 = Date.now();
  let stop = false;
  setTimeout(() => { stop = true; }, DURATION_MS).unref?.();

  async function worker() {
    while (!stop) {
      const r = await one(path);
      samples.push(r);
      const key = r.status === 0 ? "abort/error" : String(r.status);
      statuses.set(key, (statuses.get(key) || 0) + 1);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  const elapsed = (Date.now() - t0) / 1000;

  const lat = samples.map((s) => s.ms).sort((a, b) => a - b);
  const bad = [...statuses.entries()].filter(([k]) => k !== "200").reduce((n, [, v]) => n + v, 0);
  const summary = {
    path,
    n: lat.length,
    rps: +(lat.length / elapsed).toFixed(1),
    p50: percentile(lat, 50),
    p95: percentile(lat, 95),
    p99: percentile(lat, 99),
    max: lat[lat.length - 1] || 0,
    bad,
    statuses: Object.fromEntries(statuses),
  };

  let series = null;
  if (SERIES) {
    const buckets = new Map();
    for (const s of samples) {
      const sec = Math.floor((s.t - t0) / 1000);
      const b = buckets.get(sec) || { n: 0, ms: [] };
      b.n++;
      b.ms.push(s.ms);
      buckets.set(sec, b);
    }
    series = [...buckets.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([sec, b]) => {
        const sorted = [...b.ms].sort((x, y) => x - y);
        return { t: sec, n: b.n, p95: percentile(sorted, 95), max: sorted[sorted.length - 1] };
      });
  }
  return { summary, series };
}

const pad = (v, n) => String(v).padEnd(n);
console.log("base=" + BASE + " concurrency=" + CONCURRENCY + " duration=" + DURATION_MS + "ms cookie=" + (COOKIE ? "yes" : "no"));
console.log(pad("path", 16) + pad("n", 7) + pad("rps", 8) + pad("p50", 7) + pad("p95", 7) + pad("p99", 7) + pad("max", 7) + "非 200");
const results = [];
for (const raw of TARGETS) {
  const r = await bench(raw.trim());
  results.push(r);
  const s = r.summary;
  console.log(pad(s.path, 16) + pad(s.n, 7) + pad(s.rps, 8) + pad(s.p50, 7) + pad(s.p95, 7) + pad(s.p99, 7) + pad(s.max, 7) + s.bad + " " + JSON.stringify(s.statuses));
  if (r.series) {
    console.log("  SERIES " + s.path);
    for (const b of r.series) {
      console.log("   t=" + pad(b.t + "s", 6) + "n=" + pad(b.n, 5) + "p95=" + pad(b.p95, 6) + "max=" + b.max);
    }
  }
}