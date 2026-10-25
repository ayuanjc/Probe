import { createLimiter, readPositiveInt } from "@/lib/rate-limit";
import { clientKey, isCrossSite, publicMessage } from "@/lib/request-guard";
import {
  AccountError,
  accountError,
  listDevices,
  revokeDevice,
  revokeOtherDevices,
} from "@/lib/auth/account";
import { clearCookie, currentSessionId } from "@/lib/auth/session";
import { requireUser } from "@/lib/auth/guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 自己看/管自己的登录设备（/account 页）。
 *
 * 与后台那条路由的区别：这里 userId 只有一种可能 —— 自己。没有 ?userId= 参数可传，
 * 也就没有"越权踢别人"这种失败模式。
 */
const perClient = createLimiter({
  name: "auth-sessions",
  limit: readPositiveInt("PROBE_SESSION_RATE_PER_MIN", 30),
});

function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
}

export async function GET(request: Request) {
  if (isCrossSite(request)) return json({ ok: false, error: "cross_site", message: "拒绝跨站调用。" }, 403);
  /**
   * 读也要限流：每次都要扫一遍授权库再回全部设备信息，
   * 而这条路由此前一条限流都没有 —— 一个账号就能把它当免费存储/CPU 压力测试入口，
   * 异常的高频拉取也不会有任何 429 让它自己暴露出来。
   */
  const per = perClient.check(clientKey(request));
  if (!per.ok) {
    return json({ ok: false, error: "rate_limited", message: "操作过于频繁，请稍后再试。" }, 429, {
      "retry-after": String(per.retryAfterSeconds),
    });
  }
  const gate = await requireUser(request);
  if (!gate.ok) return gate.response;

  try {
    const [sessions, currentId] = await Promise.all([listDevices(gate.user.id), currentSessionId(request)]);
    return json({
      ok: true,
      currentSessionId: currentId,
      sessions,
      liveCount: sessions.filter((s) => s.live).length,
    });
  } catch (err) {
    return json({ ok: false, error: "internal", message: publicMessage(err, "读取登录设备失败。") }, 500);
  }
}

/**
 * 撤销。三种形态：
 *   DELETE ?id=S     踢掉这一枚（如果就是当前这枚，等效退出登录，顺手清 cookie）
 *   DELETE ?others=1 踢掉除当前这枚以外的全部
 */
export async function DELETE(request: Request) {
  if (isCrossSite(request)) return json({ ok: false, error: "cross_site", message: "拒绝跨站调用。" }, 403);

  const per = perClient.check(clientKey(request));
  if (!per.ok) {
    return json({ ok: false, error: "rate_limited", message: "操作过于频繁，请稍后再试。" }, 429, {
      "retry-after": String(per.retryAfterSeconds),
    });
  }

  const gate = await requireUser(request);
  if (!gate.ok) return gate.response;

  const params = new URL(request.url).searchParams;
  const id = params.get("id") ?? "";
  const others = params.get("others") === "1";
  if (!id && !others) return json({ ok: false, error: "missing_target", message: "缺少 id 或 others=1。" }, 400);

  const ip = clientKey(request);
  const currentId = await currentSessionId(request);

  try {
    if (others) {
      if (!currentId) {
        return json({ ok: false, error: "no_current", message: "找不到当前会话，请重新登录。" }, 400);
      }
      const revoked = await revokeOtherDevices({
        actor: gate.user.username,
        ip,
        userId: gate.user.id,
        keepSessionId: currentId,
      });
      return json({ ok: true, revoked });
    }

    await revokeDevice({ actor: gate.user.username, ip, userId: gate.user.id, sessionId: id });
    // 踢的是自己这一枚 = 退出当前设备。
    if (currentId && id === currentId) {
      return json({ ok: true, revoked: 1, signedOut: true }, 200, { "set-cookie": clearCookie(request) });
    }
    return json({ ok: true, revoked: 1 });
  } catch (err) {
    if (err instanceof AccountError && err.code === "not_found") {
      return json({ ok: false, error: "not_found", message: err.message }, 404);
    }
    const mapped = accountError(err, publicMessage(err, "撤销会话失败。"));
    return json({ ok: false, error: mapped.code, message: mapped.message }, mapped.status);
  }
}
