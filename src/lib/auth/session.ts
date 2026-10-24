import { createSession, findSessionByToken, revokeSession, type SessionLookup } from "./store";

/**
 * 会话 cookie 的读写。
 *
 * 不用 Next 的 middleware 来做这件事：本项目没有 proxy.ts，鉴权在
 * API 路由和 server component 里显式做（见 guard.ts）。这样"哪些入口要鉴权"
 * 是看得见的代码，而不是一个全局钩子里容易漏掉的分支。
 */

export const SESSION_COOKIE = "probe_session";

/** cookie 的 Path 跟着 PROBE_BASE_PATH 走，避免同域下别的应用也收到这枚 cookie。 */
export function cookiePath(): string {
  const raw = process.env.PROBE_BASE_PATH?.trim() ?? "";
  const trimmed = raw.replace(/\/+$/, "");
  if (!trimmed || trimmed === "/") return "/";
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

/** 默认 7 天。测试期想每天重登就把它调成 12。 */
export function sessionTtlMs(): number {
  const hours = Number(process.env.PROBE_SESSION_TTL_HOURS ?? "168");
  const safe = Number.isFinite(hours) && hours > 0 ? Math.min(hours, 24 * 365) : 168;
  return Math.round(safe * 3_600_000);
}

function wantsSecure(request?: Request): boolean {
  if (process.env.PROBE_ENABLE_HSTS === "1") return true;
  if (!request) return false;
  const proto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase();
  if (proto) return proto === "https";
  try {
    return new URL(request.url).protocol === "https:";
  } catch {
    return false;
  }
}

export function sessionCookie(token: string, maxAgeSeconds: number, request?: Request): string {
  const parts = [
    `${SESSION_COOKIE}=${token}`,
    `Path=${cookiePath()}`,
    `Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`,
    "HttpOnly",
    "SameSite=Lax",
  ];
  // 反代终止 TLS 时 request.url 是 http，所以要看 x-forwarded-proto。
  if (wantsSecure(request)) parts.push("Secure");
  return parts.join("; ");
}

export function clearCookie(request?: Request): string {
  return sessionCookie("", 0, request);
}

/** 从 Cookie 头里取会话 token。手写解析，不引 cookie 依赖。 */
export function readSessionCookie(request: Request): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const chunk of header.split(";")) {
    const eq = chunk.indexOf("=");
    if (eq < 0) continue;
    if (chunk.slice(0, eq).trim() !== SESSION_COOKIE) continue;
    const value = chunk.slice(eq + 1).trim();
    return value.length > 20 ? value : null;
  }
  return null;
}

export async function resolveSessionFromRequest(request: Request): Promise<SessionLookup | null> {
  const token = readSessionCookie(request);
  if (!token) return null;
  return findSessionByToken(token);
}

export async function issueSession(
  userId: string,
  request: Request,
  opts: { ipHash: string; userAgent: string },
): Promise<{ token: string; cookie: string; expiresAt: number }> {
  const ttl = sessionTtlMs();
  const { token, expiresAt } = await createSession({
    userId,
    ttlMs: ttl,
    ipHash: opts.ipHash,
    userAgent: opts.userAgent,
  });
  return { token, cookie: sessionCookie(token, Math.floor(ttl / 1000), request), expiresAt };
}

export async function destroySession(request: Request): Promise<void> {
  const token = readSessionCookie(request);
  if (!token) return;
  const found = await findSessionByToken(token);
  if (found.ok) await revokeSession(found.session.id);
}
