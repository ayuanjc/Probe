#!/usr/bin/env node
/**
 * 首屏体积报告：按路由汇总「同步加载」的 JS（原始 / gzip）。
 *
 * 为什么需要它：这台机器的带宽是 5Mbps（约 625KB/s），首屏多下 1MB 就是多等两秒。
 * next build 的表格只在终端里闪一下，看不到「某个改动把哪条路由推高了」。
 *
 * 数据来源：.next/server/app/**\/page_client-reference-manifest.js 里的 clientModules
 * （async:false 的才算首屏；动态 import 的图表块不该算进首屏）。
 *
 * 用法：npx next build && node scripts/size-report.mjs [路由]
 */
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { gzipSync } from "node:zlib";
import vm from "node:vm";

const APP_DIR = join(".next", "server", "app");
if (!existsSync(APP_DIR)) {
  console.error("找不到 .next/server/app —— 先跑 npx next build");
  process.exit(1);
}

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (name === "page_client-reference-manifest.js") out.push(p);
  }
  return out;
}

function loadManifest(file) {
  const sandbox = { globalThis: {} };
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(file, "utf8"), sandbox);
  const all = sandbox.globalThis.__RSC_MANIFEST ?? {};
  const key = Object.keys(all).find((k) => k.endsWith("/page")) ?? Object.keys(all)[0];
  return key ? all[key] : null;
}

function chunkFiles(manifest) {
  const files = new Set();
  const add = (list) => {
    for (const f of list ?? []) {
      const clean = String(f).replace(/^\/_next\//, "");
      if (clean.endsWith(".js")) files.add(clean);
    }
  };
  add(manifest.entryJSFiles?.layout);
  add(manifest.entryJSFiles?.page);
  for (const mod of Object.values(manifest.clientModules ?? {})) {
    if (mod && mod.async === false) add(mod.chunks);
  }
  return [...files];
}

function measure(files) {
  let raw = 0;
  let gz = 0;
  for (const f of files) {
    const p = join(".next", f);
    if (!existsSync(p)) continue;
    const buf = readFileSync(p);
    raw += buf.length;
    gz += gzipSync(buf).length;
  }
  return { raw, gz };
}

const kb = (n) => (n / 1024).toFixed(0) + "KB";
const only = process.argv[2];
const rows = [];
for (const file of walk(APP_DIR)) {
  const manifest = loadManifest(file);
  if (!manifest) continue;
  // .next/server/app/page_client-reference-manifest.js → "/"
  // .next/server/app/login/page_client-reference-manifest.js → "/login"
  const rel = relative(APP_DIR, file).replace(/page_client-reference-manifest\.js$/, "");
  const route = "/" + rel.replace(/[\\/]+$/, "");
  if (route.includes("/api/")) continue;
  if (only && route !== only) continue;
  const files = chunkFiles(manifest);
  rows.push({ route: route === "/" ? "/" : route.replace(/\/$/, ""), files: files.length, ...measure(files) });
}

rows.sort((a, b) => b.raw - a.raw);
for (const r of rows) {
  console.log(String(r.route).padEnd(16), String(r.files).padStart(2) + " sync chunks", kb(r.raw).padStart(8), "gzip", kb(r.gz).padStart(7));
}
