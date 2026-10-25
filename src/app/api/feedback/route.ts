import { NextRequest } from "next/server";
import path from "node:path";
import { appendFeedbackLine } from "@/lib/feedback-store";
import { createLimiter, readPositiveInt } from "@/lib/rate-limit";
import {
  clientKey,
  isCrossSite,
  methodNotAllowed,
  publicMessage,
  readJsonBody,
  stripControlChars,
} from "@/lib/request-guard";
import { requireUser } from "@/lib/auth/guard";
import { hashAddress } from "@/lib/auth/crypto";

/**
 * 反馈落在磁盘上，不进数据库：这台机器没有 DB，而反馈的价值是「别丢」，
 * 不是「能查」。一行一条 JSONL，`tail -n 20 .cache/feedback.jsonl` 就能读完。
 * 目录取 process.cwd()/.cache —— 与历史基线同一个位置，更新脚本覆盖源码时
 * 会跳过 .cache（见 docs/DEPLOY.md），所以不会随发版被清掉。
 */
const FILE = () => path.join(process.cwd(), ".cache", "feedback.jsonl");

const perClient = createLimiter({
  name: "feedback",
  limit: readPositiveInt("PROBE_FEEDBACK_RATE_LIMIT_PER_MIN", 5),
});

/** 反馈是随手写的短文本，32KB 已经远超一次真实提交。 */
const MAX_BODY_BYTES = 32_000;

/**
 * 轮转阈值：到这个大小就把当前文件归档、新开一份继续收。
 * 没有上限的话一个脚本就能把磁盘写满（每条 2KB，一分钟 5 次 × 无数 IP）；
 * 但「到上限就拒收」等于让后面所有人的反馈静默消失 —— 反馈存在的意义就是别丢。
 */
const MAX_FILE_BYTES = readPositiveInt("PROBE_FEEDBACK_MAX_BYTES", 8_000_000, { max: 200_000_000 });

/** 归档保留份数：磁盘占用仍有上界，运维不用记着手动清理。 */
const KEEP_ARCHIVES = readPositiveInt("PROBE_FEEDBACK_KEEP_ARCHIVES", 10, { max: 200 });

/*
 * 「看一眼大小 + 归档 + 追加」这三步必须在同一临界区里：
 * 分开做时 N 个并发请求会各自看到「还没满」再一起写，阈值只对串行成立。
 * 串行化与轮转逻辑在 src/lib/feedback-store.ts（有独立测试）。
 */

function clean(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  // 控制字符必须去掉：运维是用 `tail` 看这个文件的，
  // 一条带 ESC 序列的反馈就能在终端里伪造输出、改写屏幕（ANSI 注入）。
  return stripControlChars(value).trim().slice(0, max);
}

/** 只有 POST：GET 敲进地址栏时回结构化 405，而不是框架的空 body。 */
export const GET = () => methodNotAllowed(["POST"], "反馈要用 POST 提交。");

export async function POST(request: NextRequest) {
  if (isCrossSite(request)) {
    return Response.json({ ok: false, error: "cross_site", message: "拒绝跨站调用。" }, { status: 403 });
  }

  const auth = await requireUser(request);
  if (!auth.ok) return auth.response;

  const rl = perClient.check(clientKey(request));
  if (!rl.ok) {
    return Response.json(
      { ok: false, error: "rate_limited", message: "提交太频繁了，一分钟后再试。" },
      { status: 429, headers: { "retry-after": String(rl.retryAfterSeconds) } },
    );
  }

  const limited = await readJsonBody(request, MAX_BODY_BYTES);
  if (!limited.ok) {
    return Response.json({ ok: false, error: limited.code, message: limited.message }, { status: limited.status });
  }
  const body = limited.value;
  if (!body || typeof body !== "object") {
    return Response.json({ ok: false, error: "bad_json", message: "请求体不是合法 JSON。" }, { status: 400 });
  }

  const dir = path.dirname(FILE());
  const file = FILE();

  const raw = body as Record<string, unknown>;
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
    // 地址指纹而不是明文 IP：隐私政策里写的就是这个口径，同意日志与安全日志也一致。
    // 明文 IP 落在一份可以 `tail` 的 JSONL 里，等于把「谁提过什么」直接摊在运维终端上。
    ip: hashAddress(clientKey(request)) ?? null,
    ua: clean(request.headers.get("user-agent"), 300),
  };

  const outcome = await appendFeedbackLine(file, JSON.stringify(record) + "\n", {
    maxBytes: MAX_FILE_BYTES,
    keepArchives: KEEP_ARCHIVES,
  });
  if (!outcome.ok) {
    console.warn("[feedback] write failed:", outcome.reason);
    return Response.json(
      {
        ok: false,
        error: "write_failed",
        message: publicMessage(new Error(outcome.reason), "没写进磁盘（可能是只读文件系统或配额满），这条反馈没有保存。"),
      },
      { status: 500 },
    );
  }
  if (outcome.archived) {
    // 归档不打扰用户，但运维要能在日志里看到「文件又满过一次」的频率。
    console.info(`[feedback] ${file} 已达 ${MAX_FILE_BYTES} 字节，归档为 archive/${outcome.archived}`);
  }

  return Response.json({ ok: true, id });
}
