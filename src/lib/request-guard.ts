import { createHash, timingSafeEqual } from "node:crypto";
import { readPositiveInt } from "./rate-limit";

/**
 * 请求侧防护工具：来源识别、跨站判定、限长读体、错误脱敏、常量时间比较。
 * 所有 API 路由都从这里取，避免各路由各写一份、修一处漏三处。
 */

/**
 * 从第几跳（从右往左数）取真实客户端 IP。
 * - 直连（无反向代理）时设为 0：彻底忽略 X-Forwarded-For / X-Real-IP，
 *   否则任何客户端都能靠伪造头绕过限流。
 * - 一层 nginx（本项目 DEPLOY.md 的部署形态）默认 1：
 *   nginx 用 `$proxy_add_x_forwarded_for` 追加，真实 IP 在最右。
 */
function trustedHops(): number {
  // min: 0 —— 0 是合法取值（直连部署），不能被当成笔误回落成 1。
  return readPositiveInt("PROBE_TRUSTED_PROXY_HOPS", 1, { max: 16, min: 0 });
}

const IPV4_RE = /^\d{1,3}(?:\.\d{1,3}){3}$/;
const IPV6_RE = /^[0-9a-f:.]+$/i;

/** 归一化 + 白名单字符集，顺带把 header 里的超长垃圾挡在键表外。 */
function normalizeClient(raw: string): string | null {
  const v = raw.trim().slice(0, 64).toLowerCase();
  if (!v) return null;
  if (IPV4_RE.test(v) || IPV6_RE.test(v)) return v;
  // 形如 "[2001:db8::1]:443" 或 "2001:db8::1"
  const bracket = /^\[([0-9a-f:.]+)\]/.exec(v);
  if (bracket) return bracket[1];
  // 非 IP 文本（某些代理会塞 hostname）：只保留安全字符，长度有限
  const cleaned = v.replace(/[^a-z0-9._:-]/g, "").slice(0, 64);
  return cleaned || null;
}

/**
 * 计算限流用的客户端键。
 * 优先级：X-Forwarded-For 右起第 hops 项 -> X-Real-IP -> "direct"。
 * 取值失败一律回落到共享键 "direct"（所有人共用一份额度），
 * 而不是伪造一个独立键（那等于送攻击者免费额度）。
 */
export function clientKey(request: Request): string {
  const hops = trustedHops();
  if (hops <= 0) return "direct";

  const xff = request.headers.get("x-forwarded-for");
  if (xff) {
    const parts = xff.split(",").map((s) => s.trim()).filter(Boolean);
    const idx = parts.length - hops;
    if (idx >= 0) {
      const picked = normalizeClient(parts[idx] ?? "");
      if (picked) return picked;
    }
  }
  const real = request.headers.get("x-real-ip");
  if (real) {
    const picked = normalizeClient(real);
    if (picked) return picked;
  }
  return "direct";
}

/**
 * 是否跨站发起的请求。
 * - `Sec-Fetch-Site: cross-site` 直接判负（现代浏览器必发）。
 * - 有 Origin 时与 Host 比对（挡 CSRF 式跨站 POST/GET）。
 * - 无任何信号（curl / 服务端调用）时放行——这些请求本来就要靠限流与
 *   无鉴权的设计来兜（本项目没有会话 cookie，跨站危害有限）。
 */
export function isCrossSite(request: Request): boolean {
  const site = request.headers.get("sec-fetch-site");
  if (site && site.trim().toLowerCase() === "cross-site") return true;
  if (site && site.trim().toLowerCase() === "same-site") return false;

  const origin = request.headers.get("origin");
  if (!origin) return false;
  if (origin.trim().toLowerCase() === "null") return true;
  let originHost: string;
  try {
    originHost = new URL(origin).host.toLowerCase();
  } catch {
    return true;
  }
  const host = (request.headers.get("host") ?? "").toLowerCase();
  if (!host) return false;
  return originHost !== host;
}

export type BodyResult =
  | { ok: true; value: unknown }
  | { ok: false; status: 400 | 413; code: string; message: string };

/** 流式读取请求体，超过 maxBytes 立刻中止（不把超大 body 读进内存）。 */
async function readLimitedText(request: Request, maxBytes: number): Promise<string | null> {
  const declared = request.headers.get("content-length");
  if (declared) {
    const n = Number(declared);
    if (Number.isFinite(n) && n > maxBytes) return null;
  }
  const body = request.body;
  if (!body) return "";
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* 已释放 */
    }
  }
  const merged = new Uint8Array(size);
  let off = 0;
  for (const c of chunks) {
    merged.set(c, off);
    off += c.byteLength;
  }
  return new TextDecoder("utf-8").decode(merged);
}

/** 限长 JSON 读体：超限 413、非法 JSON 400，都不回显原文。 */
export async function readJsonBody(request: Request, maxBytes: number): Promise<BodyResult> {
  const text = await readLimitedText(request, maxBytes);
  if (text === null) {
    return {
      ok: false,
      status: 413,
      code: "body_too_large",
      message: `请求体过大（上限 ${Math.round(maxBytes / 1024)} KB）。`,
    };
  }
  if (!text.trim()) {
    return { ok: false, status: 400, code: "empty_body", message: "请求体为空。" };
  }
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, status: 400, code: "bad_json", message: "请求体不是合法 JSON。" };
  }
}

/** 统一 JSON 错误响应（可附带限流建议头）。 */
export function jsonError(
  status: number,
  code: string,
  message: string,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify({ ok: false, code, message }), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...headers,
    },
  });
}

/** 限流命中时的标准响应。 */
export function rateLimited(retryAfterSeconds: number, message?: string): Response {
  return jsonError(429, "rate_limited", message ?? "请求太频繁，请稍后再试。", {
    "retry-after": String(Math.max(1, retryAfterSeconds)),
  });
}

/**
 * 常量时间字符串比较（用于 secret / key 校验）。
 * 先 sha256 再 timingSafeEqual，长度差异也不泄露。
 */
export function constantTimeEqual(
  given: string | null | undefined,
  expected: string | null | undefined,
): boolean {
  if (!given || !expected) return false;
  const a = createHash("sha256").update(given, "utf8").digest();
  const b = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(a, b);
}

/**
 * 把内部错误转成可外发的文案：细节只进服务端日志，
 * 客户端拿到固定的公共文案（避免泄露栈、上游错误、配置状态）。
 */
export function publicMessage(err: unknown, fallback: string): string {
  const detail =
    err instanceof Error ? `${err.name}: ${err.message}` : typeof err === "string" ? err : String(err);
  console.warn(`[api] ${fallback} << ${detail}`);
  if (process.env.NODE_ENV !== "production" && err instanceof Error) {
    // 开发环境保留可调试性，线上不外发
    return `${fallback}（dev: ${err.message}）`;
  }
  return fallback;
}

/** 去掉控制字符（含 ANSI 转义），用于写入日志文件的内容。 */
export function stripControlChars(input: string): string {
  // eslint-disable-next-line no-control-regex
  return input.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "").replace(/\r\n?/g, "\n");
}
