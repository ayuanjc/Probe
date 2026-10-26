import { NextResponse } from "next/server";
import { ensureHistory } from "@/lib/heat-history";
import { getTrending } from "@/lib/trending";
import { createLimiter, readPositiveInt } from "@/lib/rate-limit";
import { clientKey, constantTimeEqual, publicMessage } from "@/lib/request-guard";
import { historyEnabled, pruneExpired } from "@/lib/history-store";
import { pruneHits, recordHits, watchEnabled, type StoryLite } from "@/lib/watch-store";
import { getHotLists, hotStories } from "@/lib/hotlist";
import { cnTrendingEnabled, getCnTrending, recentCnStories, type CnStory } from "@/lib/cn-trending";
import { recordCnStories } from "@/lib/cn-history";
import { entityEnabled, pruneEntityHits, recordEntityHits, type EntityStory } from "@/lib/entity-track";

/**
 * 后台热点计算（PRD Phase 3 第 1 项）。
 *
 * 存在的理由：热度状态标签依赖 30 天历史基线，而基线的构建要 60 次 HN 请求。
 * 让"第一个访客"来承担这件事，等于让踩进来的人等 20 秒，而且 cold start 后
 * 每个实例都会各跑一遍。改成外部定时器（Vercel Cron / GitHub Actions / cron）
 * 定期打这个端点，基线就一直在、快照也一直是热的。
 *
 * 刻意不开放：没有 PROBE_CRON_SECRET 时直接 503，而不是"先开着等以后再说"。
 * 一个无鉴权的端点能触发 60 次外部请求，被扫到就是免费的放大镜。
 */
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * 秘密尝试次数限制：常量时间比较能防时序侧信道，
 * 但挡不住「一秒一百次把 32 位 hex 撞出来」之外的成本问题 ——
 * 这个端点每通过一次就要打 60 个外部请求，先限速再谈其他。
 */
const attempts = createLimiter({
  name: "cron",
  limit: readPositiveInt("PROBE_CRON_RATE_LIMIT_PER_MIN", 10),
});

/** 太短的 secret 等于没有 secret，直接拒绝启动这个端点。 */
const MIN_SECRET_LEN = 16;

function authorized(request: Request): { ok: boolean; reason?: string; disabled?: boolean } {
  const secret = process.env.PROBE_CRON_SECRET;
  if (!secret) {
    return { ok: false, disabled: true, reason: "未配置 PROBE_CRON_SECRET：Cron 端点保持关闭。" };
  }
  if (secret.length < MIN_SECRET_LEN) {
    return {
      ok: false,
      disabled: true,
      reason: `PROBE_CRON_SECRET 太短（至少 ${MIN_SECRET_LEN} 位）。请换成 openssl rand -hex 32 的输出。`,
    };
  }
  const auth = request.headers.get("authorization");
  const direct = request.headers.get("x-probe-cron-secret");
  const bearer = auth && auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : null;
  // 常量时间比较：=== 会按第一个不同字节提前返回，时序上可逐字节试探。
  if (constantTimeEqual(bearer, secret) || constantTimeEqual(direct, secret)) return { ok: true };
  return { ok: false, reason: "密钥不匹配。" };
}

/**
 * 把快照里的 story 摊平成关注匹配要的形状（按 URL 去重）。
 * 只取 topics 里的 story：那是「进入统计」的那批，rawStories 里被过滤掉的噪音不该触发关注命中。
 */
function collectStories(snapshot: { topics: { stories: { title: string; url: string; points: number; createdAt: string; host: string }[] }[] }): StoryLite[] {
  const seen = new Set<string>();
  const out: StoryLite[] = [];
  for (const topic of snapshot.topics) {
    for (const story of topic.stories) {
      if (!story.url || seen.has(story.url)) continue;
      seen.add(story.url);
      out.push({
        title: story.title,
        url: story.url,
        host: story.host,
        provider: "hn",
        points: story.points,
        seenAt: story.createdAt,
      });
    }
  }
  return out;
}

/**
 * 中文源的 story 也丢给关注匹配：关注的是「这个实体」，不该因为它出现在
 * IT之家 而不是 HN 就装作没看见。provider 写上游 id，前端再翻成人话。
 * 只用 topics 里的（进入统计的那批），与 collectStories 同一个口径。
 */
function collectCnStories(snapshot: { topics: { stories: CnStory[] }[] }): StoryLite[] {
  const seen = new Set<string>();
  const out: StoryLite[] = [];
  for (const topic of snapshot.topics) {
    for (const story of topic.stories) {
      if (!story.url || seen.has(story.url)) continue;
      seen.add(story.url);
      out.push({
        title: story.title,
        url: story.url,
        host: story.host,
        provider: story.source,
        points: story.engagement,
        seenAt: story.createdAt,
      });
    }
  }
  return out;
}

async function run(request: Request) {
  const guard = attempts.check(clientKey(request));
  if (!guard.ok) {
    return NextResponse.json(
      { ok: false, error: "rate_limited", message: "尝试过于频繁，请稍后再试。" },
      { status: 429, headers: { "cache-control": "no-store", "retry-after": String(guard.retryAfterSeconds) } },
    );
  }

  const gate = authorized(request);
  if (!gate.ok) {
    return NextResponse.json(
      { ok: false, error: gate.disabled ? "cron_disabled" : "forbidden", message: gate.reason },
      { status: gate.disabled ? 503 : 401 },
    );
  }

  const started = Date.now();
  try {
    // 先把基线补齐（落后时才真的去抓），再强制重算一次快照。
    const history = await ensureHistory();
    const snapshot = await getTrending(true);
    // 顺手清理过期的账号级历史：这件事没有任何时效性要求，
    // 但必须有个东西固定去做 —— 挂在已有的定时任务上比再起一个 timer 省事也省故障面。
    // 失败只记日志：清不掉旧记录是小事，让热点计算整体失败是大事。
    let pruned = 0;
    if (historyEnabled()) {
      try {
        pruned = pruneExpired();
      } catch (err) {
        console.warn("[history] 过期清理失败：" + (err instanceof Error ? err.message : String(err)));
      }
    }
    // 关注命中：与快照同一次计算落库，不另起 timer。
    // 失败只记日志 —— 关注推不出来是小事，让热点计算整体 500 是大事。
    // 关注命中与实体追踪吃同一批 story：谁要就都从这里拿，避免抓两次。
    // 实体追踪是公开时间线，与「有没有人关注」无关，所以两个开关各自独立判断。
    const entityStories: EntityStory[] = [];
    let watch = { inserted: 0, ambiguous: 0, pruned: 0 };
    if (watchEnabled() || entityEnabled()) {
      try {
        const stories = collectStories(snapshot);
        entityStories.push(...stories);
        if (watchEnabled()) {
          const hits = recordHits(stories);
          watch = { ...hits, pruned: hits.pruned + pruneHits() };
        }
      } catch (err) {
        console.warn("[watch] 命中落库失败：" + (err instanceof Error ? err.message : String(err)));
      }
    }

    /**
     * 国内榜单（百度热搜 / 掘金）：与热榜并行、互不依赖。
     * 刻意不带 force —— 这层缓存就是上游的风控闸门，15 分钟一轮，
     * 让每分钟都可能被触发的 cron 不至于把百度打成 DDos。
     */
    let hot = { lists: 0, entries: 0, inserted: 0, degraded: [] as string[] };
    try {
      const snapshotHot = await getHotLists();
      const hotList = hotStories(snapshotHot);
      hot.lists = snapshotHot.lists.length;
      hot.entries = hotList.length;
      hot.degraded = snapshotHot.degraded;
      if (hotList.length > 0) {
        entityStories.push(...hotList);
        if (watchEnabled()) hot.inserted = recordHits(hotList).inserted;
      }
    } catch (err) {
      console.warn("[hotlist] 定时抓取失败：" + (err instanceof Error ? err.message : String(err)));
    }

    /**
     * 中文科技前沿：抓一轮 + 记基线。
     *
     * 记基线是这件事的**主要目的** —— 这两个源没有历史检索接口，30 天基线补不出来，
     * 只能每天读一次顺手记。所以哪怕页面没人看，cron 也得跑，否则第 14 天永远是明天。
     * 失败只记日志：基线缺一天不致命（当天少一个点），让它拖垮整轮才致命。
     */
    let cn = {
      topics: 0,
      sources: [] as { id: string; ok: boolean; count: number; coveredHours: number }[],
      baseline: { day: null as string | null, added: 0, days: 0 },
      inserted: 0,
      degraded: [] as string[],
    };
    if (cnTrendingEnabled()) {
      try {
        const snap = await getCnTrending(true);
        cn.topics = snap.topics.length;
        cn.sources = snap.sources.map((s) => ({ id: s.id, ok: s.ok, count: s.count, coveredHours: s.coveredHours }));
        cn.degraded = snap.degraded;
        // recentCnStories 是这一轮真抓到的全部 story（快照里每话题只留 3 条，
        // 拿它记基线会把计数系统性地记小）。
        const all = recentCnStories();
        if (all.length > 0) {
          const rec = await recordCnStories(all.map((s) => ({ title: s.title, url: s.url })));
          cn.baseline = { day: rec.day, added: rec.added, days: rec.days };
        }
        const lite = collectCnStories(snap);
        if (lite.length > 0) {
          entityStories.push(...lite);
          if (watchEnabled()) cn.inserted = recordHits(lite).inserted;
        }
      } catch (err) {
        console.warn("[cn] 定时抓取失败：" + (err instanceof Error ? err.message : String(err)));
      }
    }

    /**
     * 实体追踪（公开时间线）：把这一轮所有源的标题过一遍词典，命中的落库。
     * 与关注命中同一个 try 口径：写库失败只记日志，不能让热点计算整体失败。
     */
    let entities = { inserted: 0, matched: 0, pruned: 0 };
    if (entityEnabled() && entityStories.length > 0) {
      try {
        const rec = recordEntityHits(entityStories);
        entities = { ...rec, pruned: rec.pruned + pruneEntityHits() };
      } catch (err) {
        console.warn("[entity] 命中落库失败：" + (err instanceof Error ? err.message : String(err)));
      }
    }

    return NextResponse.json(
      {
        ok: true,
        elapsedMs: Date.now() - started,
        history: {
          days: history.history?.days.length ?? 0,
          from: history.history?.from ?? null,
          to: history.history?.to ?? null,
          pending: history.pending,
          reason: history.reason ?? null,
        },
        historyPruned: pruned,
        watch,
        entities,
        hot,
        cn,
        trending: {
          topics: snapshot.topics.length,
          considered: snapshot.consideredStories,
          fetched: snapshot.fetchedStories,
          degraded: snapshot.degraded,
          withStatus: snapshot.topics.filter((t) => Boolean(t.status)).length,
        },
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (err) {
    // 已鉴权的调用方也只看公共文案：响应里不该出现上游地址与内部状态。
    return NextResponse.json(
      { ok: false, error: "cron_failed", message: publicMessage(err, "热点计算失败，详见服务端日志。") },
      { status: 500, headers: { "cache-control": "no-store" } },
    );
  }
}

export async function GET(request: Request) {
  return run(request);
}

/** 有些定时器只发 POST。 */
export async function POST(request: Request) {
  return run(request);
}
