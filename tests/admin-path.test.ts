import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { ADMIN_PATH } from "../src/lib/admin-path";

/**
 * 后台路径的「防漂移」测试。
 *
 * 路径在代码里出现两次：Next 的路由靠目录名，右下角身份条的入口靠 href。
 * 只改一处的话症状是「后台能开，点按钮 404」—— 只有管理员会撞上，能躲很久。
 * 所以这里把三者钉在一起：常量 ↔ 目录 ↔ 引用。
 */
const ROOT = process.cwd();
const AS_DQ = String.fromCharCode(34) + ADMIN_PATH + String.fromCharCode(34);
const AS_SQ = String.fromCharCode(39) + ADMIN_PATH + String.fromCharCode(39);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (name.endsWith(".ts") || name.endsWith(".tsx")) out.push(p);
  }
  return out;
}

test("后台路径的格式：以 / 开头、无尾斜杠、不是人人都猜的 /admin", () => {
  assert.match(ADMIN_PATH, /^\/[a-z0-9][a-z0-9-]{1,20}$/);
  assert.notEqual(ADMIN_PATH, "/admin");
});

test("ADMIN_PATH 对应的路由目录真的存在", () => {
  const page = join(ROOT, "src", "app", ADMIN_PATH.slice(1), "page.tsx");
  assert.ok(existsSync(page), "缺少路由文件：" + page);
});

test("除 admin-path.ts 之外，没有源码硬编码后台路径", () => {
  const offenders: string[] = [];
  for (const file of walk(join(ROOT, "src"))) {
    if (file.endsWith("admin-path.ts")) continue;
    const text = readFileSync(file, "utf8");
    if (text.includes(AS_DQ) || text.includes(AS_SQ)) offenders.push(file);
  }
  assert.deepEqual(offenders, [], "这些文件绕过 ADMIN_PATH 写死了路径，改路径时会漏改：" + offenders.join(", "));
});

test("身份条的入口读 ADMIN_PATH 而不是写死字符串", () => {
  const bar = readFileSync(join(ROOT, "src", "components", "SessionBar.tsx"), "utf8");
  assert.ok(bar.includes("ADMIN_PATH"), "SessionBar 没有引用 ADMIN_PATH");
});
