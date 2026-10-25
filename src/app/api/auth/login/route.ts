import { createLimiter, readPositiveInt } from "@/lib/rate-limit";
import { clientKey, isCrossSite, publicMessage, readJsonBody } from "@/lib/request-guard";
import { hashAddress, hashPassword, normalizeUsername, verifyPassword } from "@/lib/auth/crypto";
import { audit, findUserByUsername, markLogin } from "@/lib/auth/store";
import { issueSession } from "@/lib/auth/session";
import { authMode, ensureBootstrap } from "@/lib/auth/guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 登录。三个刻意的设计：
 * 1. 用户不存在时也跑一次 scrypt —— 否则"查得太快"就等于告诉对方这个用户名存在。
 * 2. 用户名/密码错误的文案完全一样，不区分"用户不存在"和"密码错"。
 * 3. 成功和失败都计数到同一个 per-IP 额度里，避免攻击者用成功登录探路。
 */
const perClient = createLimiter({
  name: "auth-login",
  limit: readPositiveInt("PROBE_LOGIN_RATE_PER_MIN", 5),
});

const MAX_BODY_BYTES = 4_000;

/**
 * 按账号的失败退避。
 *
 * 现有的 per-IP 5 次/分钟挡不住「同一账号、很多个 IP」的撞库：
 * 换一批代理就是一个新 IP，每个 IP 都只试 1-2 次，永远不会触发限流。
 * 这里按**用户名**记失败次数，失败多了就在响应前多睡一会儿（指数退避、封顶 1.5 秒）。
 *
 * 为什么是延迟而不是直接 429：硬锁会让人拿别人的用户名把对方锁在门外（拒绝服务）。
 * 延迟只惩罚正在试的人 —— 正常用户输错两次几乎无感，而撞库的每次尝试都变慢。
 */
const BAD_WINDOW_MS = 15 * 60_000;
const BAD_SOFT_LIMIT = 3;
const badByName = new Map<string, { n: number; at: number }>();

function backoffFor(name: string): number {
  if (!name) return 0;
  const rec = badByName.get(name);
  if (!rec) return 0;
  if (Date.now() - rec.at > BAD_WINDOW_MS) {
    badByName.delete(name);
    return 0;
  }
  if (rec.n < BAD_SOFT_LIMIT) return 0;
  return Math.min(1_500, (rec.n - BAD_SOFT_LIMIT + 1) * 200);
}

function noteBadName(name: string): void {
  if (!name) return;
  const rec = badByName.get(name);
  const now = Date.now();
  if (!rec || now - rec.at > BAD_WINDOW_MS) {
    badByName.set(name, { n: 1, at: now });
  } else {
    badByName.set(name, { n: rec.n + 1, at: now });
  }
  // 表本身不能无界：过期条目先清，仍然太多就整体丢掉（丢掉的代价只是退避重置）。
  if (badByName.size > 2_048) {
    for (const [key, value] of badByName) {
      if (now - value.at > BAD_WINDOW_MS) badByName.delete(key);
    }
    if (badByName.size > 2_048) badByName.clear();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 用户不存在时拿去空转的哈希，只在第一次用到时算一次。 */
let dummyHash: Promise<string> | null = null;
function getDummyHash(): Promise<string> {
  if (!dummyHash) dummyHash = hashPassword("timing-equalizer-not-a-real-account");
  return dummyHash;
}

function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...headers,
    },
  });
}

export async function POST(request: Request) {
  if (isCrossSite(request)) return json({ ok: false, error: "cross_site", message: "拒绝跨站调用。" }, 403);
  if (authMode() === "off") {
    return json({ ok: false, error: "auth_off", message: "当前实例未开启鉴权（PROBE_AUTH_MODE=off）。" }, 409);
  }

  const per = perClient.check(clientKey(request));
  if (!per.ok) {
    return json(
      { ok: false, error: "rate_limited", message: `尝试过于频繁，请 ${per.retryAfterSeconds} 秒后再试。` },
      429,
      { "retry-after": String(per.retryAfterSeconds) },
    );
  }

  const limited = await readJsonBody(request, MAX_BODY_BYTES);
  if (!limited.ok) return json({ ok: false, error: limited.code, message: limited.message }, limited.status);
  const body = limited.value as { username?: unknown; password?: unknown } | null;
  const rawName = typeof body?.username === "string" ? body.username : "";
  const password = typeof body?.password === "string" ? body.password : "";

  if (!rawName || !password) {
    return json({ ok: false, error: "missing_field", message: "请填写用户名和密码。" }, 400);
  }

  const username = normalizeUsername(rawName);
  const ip = clientKey(request);
  try {
    await ensureBootstrap();
    const user = username ? await findUserByUsername(username) : null;
    // 失败次数够了就先慢下来（在付出 scrypt 代价之前，省得被当 CPU 放大器）。
    const wait = backoffFor(username ?? "");
    if (wait > 0) await sleep(wait);
    // 无论有没有这个用户，都付出一次 scrypt 的代价。
    const ok = user
      ? await verifyPassword(password, user.passwordHash)
      : await verifyPassword(password, await getDummyHash());

    if (!user || !ok) {
      noteBadName(username ?? "");
      await audit({ actor: username ?? rawName.slice(0, 32), action: "login_failed", ip });
      return json({ ok: false, error: "bad_credentials", message: "用户名或密码不正确。" }, 401);
    }
    if (user.status !== "active") {
      await audit({ actor: user.username, action: "login_disabled", ip });
      return json({ ok: false, error: "account_disabled", message: "账号已被停用，请联系管理员。" }, 403);
    }

    // 登录成功就把这个账号的失败计数清掉：一次成功足够证明它是本人在用。
    if (username) badByName.delete(username);
    const session = await issueSession(user.id, request, {
      ipHash: hashAddress(ip),
      userAgent: request.headers.get("user-agent") ?? "",
    });
    await markLogin(user.id);
    await audit({ actor: user.username, action: "login", target: user.username, ip });

    return json(
      {
        ok: true,
        user: {
          username: user.username,
          role: user.role,
          mustChangePassword: user.mustChangePassword,
        },
        expiresAt: session.expiresAt,
      },
      200,
      { "set-cookie": session.cookie },
    );
  } catch (err) {
    return json({ ok: false, error: "internal", message: publicMessage(err, "登录失败，请稍后重试。") }, 500);
  }
}
