import { NextRequest } from "next/server";
import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * 反馈落在磁盘上，不进数据库：这台机器没有 DB，而反馈的价值是「别丢」，
 * 不是「能查」。一行一条 JSONL，`tail -n 20 .cache/feedback.jsonl` 就能读完。
 * 目录取 process.cwd()/.cache —— 与历史基线同一个位置，更新脚本覆盖源码时
 * 会跳过 .cache（见 docs/DEPLOY.md），所以不会随发版被清掉。
 */
const FILE = () => path.join(process.cwd(), ".cache", "feedback.jsonl");

const RL_MAX = Number(process.env.PROBE_FEEDBACK_RATE_LIMIT_PER_MIN ?? 5);
/** 每个 IP 的提交时间戳。超过 512 条时顺带清掉过期的，避免常驻增长。 */
const hits = new Map<string, number[]>();

function limited(ip: string): boolean {
  if (!Number.isFinite(RL_MAX) || RL_MAX <= 0) return false;
  const now = Date.now();
  const window = 60_000;
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < window);
  if (recent.length >= RL_MAX) {
    hits.set(ip, recent);
    return true;
  }
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 512) {
    for (const [key, list] of hits) {
      if (list.every((t) => now - t >= window)) hits.delete(key);
    }
  }
  return false;
}

function clean(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, max);
}

export async function POST(request: NextRequest) {
  const ip =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "unknown";

  if (limited(ip)) {
    return Response.json(
      { ok: false, error: "rate_limited", message: "提交太频繁了，一分钟后再试。" },
      { status: 429, headers: { "retry-after": "60" } },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json(
      { ok: false, error: "bad_json", message: "请求体不是合法 JSON。" },
      { status: 400 },
    );
  }

  const raw = (body ?? {}) as Record<string, unknown>;
  const message = clean(raw.message, 2000);
  const contact = clean(raw.contact, 120);
  const query = clean(raw.query, 200);
  const page = clean(raw.page, 200);
  if (message.length < 2) {
    return Response.json(
      { ok: false, error: "empty_message", message: "写两句再发吧（至少 2 个字）。" },
      { status: 400 },
    );
  }

  const id = Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
  const record = {
    id,
    at: new Date().toISOString(),
    message,
    contact,
    query,
    page,
    ip,
    ua: clean(request.headers.get("user-agent"), 300),
  };

  try {
    await fs.mkdir(path.dirname(FILE()), { recursive: true });
    await fs.appendFile(FILE(), JSON.stringify(record) + "\n", "utf8");
  } catch (err) {
    console.warn("[feedback] write failed:", err instanceof Error ? err.message : err);
    return Response.json(
      {
        ok: false,
        error: "write_failed",
        message: "没写进磁盘（可能是只读文件系统或配额满），这条反馈没有保存。",
      },
      { status: 500 },
    );
  }

  return Response.json({ ok: true, id });
}