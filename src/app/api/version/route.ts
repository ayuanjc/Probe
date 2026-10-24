import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * 客户端靠这个接口发现「线上已经换了构建」。
 *
 * 关键是**进程启动时读一次**：自动更新脚本重新 build 之后 .next/BUILD_ID 会变，
 * 新起的进程读到新值；如果每次请求都去读文件，跑着旧代码的进程会立刻报出新版本号，
 * 于是所有人被提示刷新到一个其实还没生效的版本。
 */
function readBuildId(): string {
  try {
    return readFileSync(path.join(process.cwd(), ".next", "BUILD_ID"), "utf8").trim();
  } catch {
    // dev（Turbopack）不写 BUILD_ID：返回 unknown，客户端就不会弹提示。
    return "unknown";
  }
}

const BUILD_ID = readBuildId();
const STARTED_AT = new Date().toISOString();

export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json(
    { buildId: BUILD_ID, startedAt: STARTED_AT },
    { headers: { "cache-control": "no-store" } },
  );
}