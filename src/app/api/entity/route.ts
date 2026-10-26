import { NextResponse } from "next/server";
import { createLimiter, readPositiveInt } from "@/lib/rate-limit";
import { clientKey } from "@/lib/request-guard";
import { buildTimeline } from "@/lib/entity-timeline";
import { entityEnabled, entitySummary, listEntityHits, topEntities } from "@/lib/entity-track";

/**
 * 公开实体接口：GET /api/entity?key=台积电
 *
 * 这是全站**唯一不需要登录就能读到内容的 API**，所以三道闸都要在：
 *   1. 只读：没有写方法，也没有任何写路径；
 *   2. 限流：按 IP 每分钟 N 次（默认 300）—— 它读的是本地 SQLite，
 *      单个请求的代价是几毫秒，但一次拉一万条就会把 2 核机器占满；
 *   3. 只回索引：标题 / 链接 / 来源 / 档位 / 时间，没有正文、没有用户痕迹。
 *
 * 不做 isCrossSite：这里没有 cookie 身份，跨站读到的只是公开数据；
 * 反过来把跨站挡掉会让别人没法做外链卡片，而这一层的价值恰恰是能被引用。
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const limiter = createLimiter({
  name: "entity",
  limit: readPositiveInt("PROBE_ENTITY_RATE_PER_MIN", 300),
});

function noStore(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });
}

export async function GET(request: Request) {
  if (!entityEnabled()) {
    return noStore({ ok: true, enabled: false, entities: [], events: [], next: null });
  }

  const per = limiter.check(clientKey(request));
  if (!per.ok) {
    return NextResponse.json(
      { ok: false, enabled: true, error: "rate_limited", message: "请求过于频繁。" },
      {
        status: 429,
        headers: { "cache-control": "no-store", "retry-after": String(per.retryAfterSeconds) },
      },
    );
  }

  const url = new URL(request.url);
  const key = (url.searchParams.get("key") ?? "").trim().slice(0, 60);
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 60) || 60, 1), 200);
  const before = Math.max(0, Math.floor(Number(url.searchParams.get("before") ?? 0) || 0));
  const days = Math.min(Math.max(Number(url.searchParams.get("days") ?? 7) || 7, 0), 365);

  // 不带 key：返回「最近被提到最多的实体」，给 /entities 索引页用。
  if (!key) {
    return noStore({ ok: true, enabled: true, days, entities: topEntities({ days, limit: 30 }) });
  }

  const summary = entitySummary(key);
  const page = listEntityHits(summary.key, { limit, before });
  return noStore({
    ok: true,
    enabled: true,
    summary,
    events: buildTimeline(page.items),
    next: page.next,
  });
}
