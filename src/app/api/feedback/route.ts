import { NextRequest } from "next/server";
import { promises as fs } from "node:fs";
import path from "node:path";
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
 * 文件上限。没有这条，一个脚本就能把磁盘写满（每条 2KB，一分钟 5 次 × 无数 IP），
 * 顺带把整台机器上的其他服务一起拖死。超限后停止接收并明确告知，
 * 而不是悄悄丢掉或者无限轮转 —— 运维需要知道"该归档了"。
 */
const MAX_FILE_BYTES = readPositiveInt("PROBE_FEEDBACK_MAX_BYTES", 8_000_000, { max: 200_000_000 });

/**
 * 写盘串行化。
 *
 * 原来的顺序是「stat 一次看有没有超限 → 再 append」，两步之间没有任何互斥：
 * N 个并发请求同时看到 7.99MB 都会放行，各自 append 一条，实际写进去 N 条 ——
 * 上限只对串行请求成立。这里用一条 Promise 链把「看一眼大小 + 追加」压成临界区，
 * 进程内并发不再能越限。（多实例部署仍需文件锁，本服务是单进程 systemd 单元。）
 */
let writeQueue: Promise<unknown> = Promise.resolve();
function withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = writeQueue.then(fn, fn);
  writeQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

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

  try {
    // 配额判定与追加在同一临界区里：并发请求不能各自看到「还没满」再一起写进去。
    const outcome = await withWriteLock(async () => {
      const stat = await fs.stat(file).catch(() => null);
      if (stat && stat.size > MAX_FILE_BYTES) return { full: stat.size } as const;
      await fs.mkdir(dir, { recursive: true, mode: 0o700 });
      // mode 只在文件新建时生效：反馈里可能有联系方式，别让同机其他用户读到。
      await fs.appendFile(file, JSON.stringify(record) + "\n", { encoding: "utf8", mode: 0o600 });
      return { full: null } as const;
    });
    if (outcome.full !== null) {
      console.warn(`[feedback] ${file} 已达 ${outcome.full} 字节上限（${MAX_FILE_BYTES}），停止接收。请归档后清空。`);
      return Response.json(
        {
          ok: false,
          error: "storage_full",
          message: "反馈存储已满，暂时无法接收新反馈（请联系维护者归档 .cache/feedback.jsonl）。",
        },
        { status: 503 },
      );
    }
  } catch (err) {
    console.warn("[feedback] write failed:", err instanceof Error ? err.message : err);
    return Response.json(
      {
        ok: false,
        error: "write_failed",
        message: publicMessage(err, "没写进磁盘（可能是只读文件系统或配额满），这条反馈没有保存。"),
      },
      { status: 500 },
    );
  }

  return Response.json({ ok: true, id });
}
