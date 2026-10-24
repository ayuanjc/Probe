import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { jsonError } from "../request-guard";
import {
  AuthStoreError,
  bumpUsage,
  ensureAdminFromEnv,
  findSessionByToken,
  touchSession,
  type StoredUser,
} from "./store";
import { SESSION_COOKIE, clearCookie } from "./session";

/**
 * 鉴权闸门。
 *
 * 原则：**API 路由才是安全边界**。页面上的 redirect 只是体验，
 * 真正拦住未授权访问的是每个 route 开头的那次 `requireUser`。
 * 页面级只做重定向，不做数据保护 —— 万一哪天漏了一个页面，
 * 数据也拿不到，因为数据都走 API。
 */

export type AuthMode = "on" | "off";

/** PROBE_AUTH_MODE=off 只在本地调试用；默认 on。 */
export function authMode(): AuthMode {
  const raw = (process.env.PROBE_AUTH_MODE ?? "on").trim().toLowerCase();
  return raw === "off" || raw === "0" || raw === "false" || raw === "disabled" ? "off" : "on";
}

let bootstrap: Promise<void> | null = null;

/** 首次鉴权时懒执行一次"空库种管理员"，不在模块顶层做 I/O。 */
export function ensureBootstrap(): Promise<void> {
  if (!bootstrap) {
    bootstrap = ensureAdminFromEnv()
      .then((r) => {
        if (r.created) console.info(`[auth] 已用环境变量初始化管理员 ${r.username}`);
      })
      .catch((err: unknown) => {
        const detail = err instanceof Error ? err.message : String(err);
        console.error(`[auth] 初始化管理员失败：${detail}`);
      });
  }
  return bootstrap;
}

/** 鉴权关闭时的占位用户：让下游代码不必到处判空。 */
function systemUser(): StoredUser {
  const now = Date.now();
  return {
    id: "auth-off",
    username: "auth-off",
    role: "admin",
    status: "active",
    passwordHash: "",
    createdAt: now,
    createdBy: "system",
    updatedAt: now,
    lastLoginAt: null,
    mustChangePassword: false,
    note: "PROBE_AUTH_MODE=off",
    inviteId: null,
    usage: { day: "", calls: 0 },
  };
}

/* ------------------------- 用量计数（合并写入） ------------------------- */

const pendingUsage = new Map<string, number>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function countUsage(userId: string): void {
  pendingUsage.set(userId, (pendingUsage.get(userId) ?? 0) + 1);
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    const batch = [...pendingUsage.entries()];
    pendingUsage.clear();
    for (const [id, n] of batch) {
      void bumpUsage(id, n).catch(() => undefined);
    }
  }, 5_000);
  flushTimer.unref?.();
}

/* ------------------------------- API 闸门 ------------------------------- */

export type AuthResult = { ok: true; user: StoredUser } | { ok: false; response: Response };

function unauthorized(reason: "none" | "expired" | "revoked" | "disabled", request: Request): Response {
  if (reason === "disabled") {
    return jsonError(403, "account_disabled", "账号已被停用，请联系管理员。");
  }
  const expired = reason === "expired" || reason === "revoked";
  return jsonError(
    401,
    expired ? "session_expired" : "auth_required",
    expired ? "登录已过期，请重新登录。" : "需要登录后使用。",
    { "set-cookie": clearCookie(request) },
  );
}

export async function requireUser(request: Request): Promise<AuthResult> {
  if (authMode() === "off") return { ok: true, user: systemUser() };
  await ensureBootstrap();

  const header = request.headers.get("cookie");
  let token: string | null = null;
  if (header) {
    for (const chunk of header.split(";")) {
      const eq = chunk.indexOf("=");
      if (eq > 0 && chunk.slice(0, eq).trim() === SESSION_COOKIE) {
        token = chunk.slice(eq + 1).trim() || null;
        break;
      }
    }
  }
  if (!token) return { ok: false, response: unauthorized("none", request) };

  try {
    const found = await findSessionByToken(token);
    if (!found.ok) return { ok: false, response: unauthorized(found.reason, request) };
    countUsage(found.user.id);
    void touchSession(found.session.id).catch(() => undefined);
    return { ok: true, user: found.user };
  } catch (err) {
    if (err instanceof AuthStoreError && err.code === "store_corrupt") {
      console.error(`[auth] ${err.message}`);
      return {
        ok: false,
        response: jsonError(503, "auth_unavailable", "授权数据暂时不可用，请联系管理员。"),
      };
    }
    throw err;
  }
}

export async function requireAdmin(request: Request): Promise<AuthResult> {
  const gate = await requireUser(request);
  if (!gate.ok) return gate;
  if (gate.user.role !== "admin") {
    return { ok: false, response: jsonError(403, "forbidden", "需要管理员权限。") };
  }
  return gate;
}

/* ----------------------------- 页面级闸门 ----------------------------- */

/** 带 PROBE_BASE_PATH 前缀的站内路径（反代把应用挂在子路径下）。 */
export function sitePath(path: string): string {
  const raw = process.env.PROBE_BASE_PATH?.trim().replace(/\/+$/, "") ?? "";
  const base = raw && raw !== "/" ? (raw.startsWith("/") ? raw : `/${raw}`) : "";
  return `${base}${path}`;
}

async function pageSessionUser(): Promise<StoredUser | null> {
  if (authMode() === "off") return systemUser();
  await ensureBootstrap();
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value ?? "";
  if (!token) return null;
  const found = await findSessionByToken(token);
  return found.ok ? found.user : null;
}

/**
 * server component 用：未登录直接 redirect 到 /login。
 * 注意这里**不能**写 cookie —— server component 没有响应头可写，
 * 失效的 cookie 由 /api/auth/me 或下一次 API 调用清。
 */
export async function requirePageUser(
  options: { allowPendingPassword?: boolean } = {},
): Promise<StoredUser> {
  const user = await pageSessionUser();
  if (!user) redirect(sitePath("/login"));
  // 被派了初始密码的人先去改密：这不是安全边界（API 本来就能用），
  // 只是别让人一直拿着管理员发的临时密码干活。/account 自己传 allowPendingPassword 破环。
  if (user.mustChangePassword && !options.allowPendingPassword) redirect(sitePath("/account"));
  return user;
}

export async function requirePageAdmin(): Promise<StoredUser> {
  const user = await pageSessionUser();
  if (!user) redirect(sitePath("/login"));
  if (user.role !== "admin") redirect(sitePath("/"));
  return user;
}

/** 页面用：已登录就别再看登录页了。 */
export async function pageUserOrNull(): Promise<StoredUser | null> {
  return pageSessionUser();
}
