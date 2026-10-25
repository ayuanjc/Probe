import { NextRequest } from "next/server";
import { createLimiter, readPositiveInt } from "@/lib/rate-limit";
import { clientKey, isCrossSite, jsonError, readJsonBody } from "@/lib/request-guard";
import {
  CONSENT_COOKIE,
  CONSENT_MAX_AGE_SECONDS,
  CONSENT_MIN_READ_MS,
  consentCookiePath,
  consentCookieValue,
} from "@/lib/consent";
import { recordConsent } from "@/lib/consent-log";
import { TERMS_VERSION } from "@/lib/legal/version";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 同意记录端点。
 *
 * 三件事，缺一件这个「10 秒强制阅读」就只是装饰：
 *   1. **版本校验**：只接受当前版本的确认。协议改版后旧版请求被 409 挡回去，
 *      客户端据此重新弹层 —— 否则拿着上个月的 cookie 也能把新条款「同意」掉。
 *   2. **服务端落盘**：写一行摘要到 .data/consent/consent.log（地址指纹而非明文 IP）。
 *      只靠浏览器 cookie 的话，举证时等于让用户自己证明自己同意过。
 *   3. **Cookie 由服务端下发**：HttpOnly 关掉（客户端要能读出来判断），但 Path、
 *      SameSite 由服务端定，避免挂在 /probe 时写到宿主机根路径上。
 *
 * 这个端点**不要求登录**：弹层出现在登录之前，而同意本身不是账号行为。
 */

const perClient = createLimiter({
  name: "consent",
  limit: readPositiveInt("PROBE_CONSENT_RATE_PER_MIN", 10),
});

/** 一次确认只有三个短字段，2KB 足够。 */
const MAX_BODY_BYTES = 2_000;

function toNumber(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^[0-9]{1,12}$/.test(value)) return Number(value);
  return fallback;
}

export async function POST(request: NextRequest) {
  if (isCrossSite(request)) {
    return jsonError(403, "cross_site", "拒绝跨站调用。");
  }

  const rl = perClient.check(clientKey(request));
  if (!rl.ok) {
    return jsonError(429, "rate_limited", "确认得太频繁了，请稍后重试。", {
      "retry-after": String(rl.retryAfterSeconds),
    });
  }

  const limited = await readJsonBody(request, MAX_BODY_BYTES);
  if (!limited.ok) {
    return jsonError(limited.status, limited.code, limited.message);
  }
  const body = limited.value;
  if (!body || typeof body !== "object") {
    return jsonError(400, "bad_json", "请求体不是合法 JSON。");
  }

  const version = typeof (body as { version?: unknown }).version === "string"
    ? ((body as { version: string }).version).trim().slice(0, 40)
    : "";
  if (version !== TERMS_VERSION) {
    // 409 而不是 400：这不是「格式错」，是「你同意的那一版已经不是现行版本了」。
    return Response.json(
      { ok: false, error: "version_mismatch", message: "协议已更新，请重新阅读并确认。", version: TERMS_VERSION },
      { status: 409 },
    );
  }

  const msRead = Math.min(3_600_000, Math.max(0, Math.round(toNumber((body as { msRead?: unknown }).msRead, 0))));
  if (msRead < CONSENT_MIN_READ_MS) {
    // 客户端倒计时没走完就提交，说明是脚本或改了前端。不记、不认。
    return jsonError(400, "read_too_fast", "请完整阅读后再确认。");
  }

  /**
   * cookie 里的时间戳用**服务端**时间，不再采信客户端自报的 at。
   * 客户端传 0 会写出「1 秒 = 1970」的同意凭据，而 parseConsentCookie 会把 2020 以前的时间戳
   * 判成伪造 —— 同一枚 cookie 由本服务发出去、又被自己判无效，用户下一刷还得再同意一次。
   * 时间本来就是「服务端观察到这次同意」的时刻，没有必要问客户端。
   */
  const at = Date.now();

  await recordConsent({
    version,
    msRead,
    ip: clientKey(request),
    userAgent: request.headers.get("user-agent") ?? "",
  });

  const cookie = [
    CONSENT_COOKIE + "=" + consentCookieValue(version, at),
    "Path=" + consentCookiePath(),
    "Max-Age=" + CONSENT_MAX_AGE_SECONDS,
    "SameSite=Lax",
    // 不设 HttpOnly：客户端要读它来避免闪一下弹层；它是「我同意过」的声明，
    // 不是权限凭据，伪造它只会让别人自己承担未同意带来的风险。
  ].join("; ");

  return Response.json(
    { ok: true, version, at },
    { status: 200, headers: { "set-cookie": cookie, "cache-control": "no-store" } },
  );
}

/** 客户端启动时问一句「现在该同意哪一版」，避免把版本号硬编码进前端包。 */
export async function GET() {
  return Response.json(
    { ok: true, version: TERMS_VERSION, minReadMs: CONSENT_MIN_READ_MS },
    { headers: { "cache-control": "no-store" } },
  );
}