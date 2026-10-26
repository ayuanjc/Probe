/**
 * 中文科技前沿（A 阶段）：基线幂等、日序列、抓取与降级。
 *
 * 每条断言对着一个会伤人的后果：
 *   - cron 每 30 分钟读一遍，同一篇文章被算 20 次 → 日计数变成「轮次 × 条数」，全是假的；
 *   - IT之家 postdate 没有时区，按运行机器时区解释 → 服务器 UTC 上 9 小时前的稿子
 *     变成 9 小时后，24 小时窗口和衰减因子一起废；
 *   - 少数派按固定 20 推进 offset，但真实页大小不是 20 → 每翻一页跳过一整页；
 *   - 基线不到 14 天就出状态标签 → 拿一个点估出来的「升温期」骗人；
 *   - 一个源挂了把另一块也清零 → 页面上什么都没了。
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  CN_BOOTSTRAP_DAYS,
  cnHistoryMeta,
  cnSeries,
  emptyCnHistory,
  mergeCnDay,
  utcDayOf,
  type CnSeen,
} from "@/lib/cn-history";
import {
  __testResetCnCache,
  cnTrendingEnabled,
  fetchCnStories,
  getCnTrending,
} from "@/lib/cn-trending";

const NOW = Date.parse("2026-10-26T09:00:00+08:00");
const DAY = 24 * 3600 * 1000;

test("日计数幂等：同一批文章被读两遍，计数只加一次", () => {
  const stories = [
    { title: "台积电 3nm 产能吃紧", url: "https://www.ithome.com/1/017/750.htm" },
    { title: "英伟达 发布新卡", url: "https://www.ithome.com/1/017/751.htm" },
  ];
  const first = mergeCnDay([], [], stories, NOW);
  assert.equal(first.added, 2);
  assert.equal(first.skipped, 0);
  assert.equal(first.day, "2026-10-26");
  const counts = first.days[0].counts;
  assert.equal(counts["台积电"], 1);

  const second = mergeCnDay(first.days, first.seen, stories, NOW + 30 * 60 * 1000);
  assert.equal(second.added, 0, "第二轮不该再加任何计数");
  assert.equal(second.skipped, 2);
  assert.deepEqual(second.days[0].counts, counts, "计数必须原样不动");
});

test("跨 UTC 日界：新的一天独立计数，昨天那份不丢", () => {
  const stories = [{ title: "台积电 涨价", url: "https://www.ithome.com/a.htm" }];
  const d1 = mergeCnDay([], [], stories, NOW);
  const d2 = mergeCnDay(d1.days, d1.seen, stories, NOW + DAY);
  assert.equal(d2.days.length, 2);
  assert.equal(d2.days[0].counts["台积电"], 1, "昨天仍然是 1");
  assert.equal(d2.days[1].counts["台积电"], 1, "今天也是 1（新的一天重新算）");
  assert.equal(d2.added, 1);
});

test("没命中实体的文章也记 URL：否则每轮都要重新匹配一遍", () => {
  const stories = [{ title: "某篇完全不涉及词典实体的稿子", url: "https://www.ithome.com/x.htm" }];
  const r = mergeCnDay([], [], stories, NOW);
  assert.equal(r.added, 0, "没命中实体不加计数");
  assert.equal(r.days[0].counts["台积电"], undefined);
  const again = mergeCnDay(r.days, r.seen, stories, NOW + 60_000);
  assert.equal(again.skipped, 1, "URL 已在当日集合里 —— 下次直接跳过");
});

test("seen 只留最近两天，日计数留最近 45 天", () => {
  const days = Array.from({ length: 50 }, (_, i) => ({ day: utcDayOf(NOW - (50 - i) * DAY), counts: { 台积电: i } }));
  const seen: CnSeen[] = [
    { day: utcDayOf(NOW - 5 * DAY), urls: ["https://old"] },
    { day: utcDayOf(NOW - DAY), urls: ["https://yesterday"] },
  ];
  const r = mergeCnDay(days, seen, [{ title: "台积电 今天", url: "https://today" }], NOW);
  assert.equal(r.days.length, 45, "日计数最多留 45 天");
  assert.deepEqual(
    r.seen.map((s) => s.day).sort(),
    [utcDayOf(NOW - DAY), utcDayOf(NOW)].sort(),
    "seen 只留昨天与今天：更早的 URL 集合没有用处",
  );
});

test("日序列：升序、不含今天、缺的日期补 0", () => {
  const day1 = utcDayOf(NOW - 3 * DAY);
  const day2 = utcDayOf(NOW - DAY);
  const history = {
    version: 1,
    builtAt: null,
    days: [
      { day: day1, counts: { 台积电: 4 } },
      { day: day2, counts: { 台积电: 7 } },
    ],
    seen: [],
  };
  const series = cnSeries(history, "台积电", 3, NOW);
  assert.deepEqual(series, [4, 0, 7], "第 3 天到第 1 天，中间那天没有记录就是 0");
  assert.deepEqual(cnSeries(null, "台积电", 3, NOW), [], "没有基线就是空数组，不是三个 0");
});

test("基线不够 14 天就是 pending —— 这时候不许出状态标签", () => {
  const history = {
    version: 1,
    builtAt: null,
    days: Array.from({ length: 5 }, (_, i) => ({ day: utcDayOf(NOW - (5 - i) * DAY), counts: {} })),
    seen: [],
  };
  const meta = cnHistoryMeta(history, NOW);
  assert.equal(meta.days, 5);
  assert.equal(meta.needed, CN_BOOTSTRAP_DAYS);
  assert.equal(meta.pending, true);
  assert.equal(cnHistoryMeta(emptyCnHistory(), NOW).pending, true);
});

test("抓取：IT之家接口与 RSS 合并去重、只留 24 小时内", async () => {
  const realFetch = globalThis.fetch;
  const LIST = {
    newslist: [
      // 北京时间 09:13，NOW 也是 +08:00 的 09:00 → 13 分钟后，属于 24h 内
      { title: "台积电 3nm 产能吃紧 IT之家", url: "/1/017/750.htm", postdate: "2026-10-26T09:13:15.287", hitcount: 12, commentcount: 3 },
      // 两天前 → 必须被丢掉
      { title: "很久以前的旧闻不该出现", url: "/1/017/000.htm", postdate: "2026-10-24T09:13:15.287", hitcount: 1 },
    ],
  };
  const RSS = `<rss><channel>
    <item><title>英伟达 发布新卡</title><link>https://www.ithome.com/1/017/748.htm</link><pubDate>Mon, 26 Oct 2026 01:09:10 GMT</pubDate></item>
    <item><title>台积电 3nm 产能吃紧 IT之家</title><link>https://www.ithome.com/1/017/750.htm</link><pubDate>Mon, 26 Oct 2026 01:13:15 GMT</pubDate></item>
  </channel></rss>`;
  const SSPAI = {
    data: [
      { id: 117460, title: "少数派：聊聊台积电的代工生意", released_time: Math.floor(NOW / 1000) - 3600, view_count: 100, like_count: 5, comment_count: 2 },
    ],
  };
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    if (url.includes("api.ithome.com")) return new Response(JSON.stringify(LIST), { status: 200 });
    if (url.includes("ithome.com/rss")) return new Response(RSS, { status: 200 });
    if (url.includes("sspai.com")) return new Response(JSON.stringify(SSPAI), { status: 200 });
    return new Response("nope", { status: 404 });
  }) as typeof fetch;

  const before = process.env.PROBE_CN_TRENDING_SOURCES;
  delete process.env.PROBE_CN_TRENDING_SOURCES;
  try {
    const r = await fetchCnStories(NOW);
    const urls = r.stories.map((s) => s.url).sort();
    assert.deepEqual(
      urls,
      [
        "https://sspai.com/post/117460",
        "https://www.ithome.com/1/017/748.htm",
        "https://www.ithome.com/1/017/750.htm",
      ],
      "旧的丢掉、RSS 与接口重复的那条只留一份",
    );
    const tsmc = r.stories.find((s) => s.url === "https://www.ithome.com/1/017/750.htm");
    assert.equal(tsmc?.engagement, 15, "接口那条带互动数（12+3），去重时保留它而不是 RSS 的 0");
    assert.equal(tsmc?.createdAt, "2026-10-26T01:13:15.287Z", "postdate 按 +08:00 解析，不是按运行机器时区");
    assert.equal(r.sources.find((s) => s.id === "sspai")?.count, 1);
    assert.ok(r.sources.every((s) => s.ok));
    const sspaiStory = r.stories.find((s) => s.source === "sspai");
    assert.equal(sspaiStory?.engagement, 107, "阅读 + 点赞 + 评论，就是页面上的「互动」");
  } finally {
    globalThis.fetch = realFetch;
    if (before !== undefined) process.env.PROBE_CN_TRENDING_SOURCES = before;
  }
});

test("一个源挂了不拖累另一个：降级写清楚是哪一边", async () => {
  const realFetch = globalThis.fetch;
  let rssCalls = 0;
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    if (url.includes("ithome.com/rss")) {
      rssCalls++;
      throw new Error("boom");
    }
    if (url.includes("api.ithome.com")) {
      return new Response(
        JSON.stringify({ newslist: [{ title: "台积电 恢复供货", url: "/1/017/9.htm", postdate: "2026-10-26T08:00:00.000" }] }),
        { status: 200 },
      );
    }
    if (url.includes("sspai.com")) return new Response(JSON.stringify({ data: [] }), { status: 200 });
    return new Response("nope", { status: 404 });
  }) as typeof fetch;
  try {
    const r = await fetchCnStories(NOW);
    assert.equal(rssCalls, 2, "一次重试：两次都失败才放弃");
    assert.ok(r.degraded.includes("ithome:rss_failed"));
    assert.equal(r.stories.length, 1, "接口那条照常进来");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("两条源全挂：记 cn:empty，不是静默空榜", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("down");
  }) as typeof fetch;
  try {
    const r = await fetchCnStories(NOW);
    assert.equal(r.stories.length, 0);
    assert.ok(r.degraded.includes("cn:empty"));
    assert.ok(r.degraded.includes("ithome:list_failed"));
    assert.ok(r.degraded.includes("sspai:failed"));
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("快照：基线为空时明说 baseline_empty，且缓存期内不再打上游", async () => {
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async (input: unknown) => {
    calls++;
    const url = String(input);
    if (url.includes("api.ithome.com")) {
      return new Response(
        JSON.stringify({
          newslist: [
            { title: "台积电 恢复供货", url: "/1/017/9.htm", postdate: "2026-10-26T08:00:00.000", hitcount: 3 },
            { title: "台积电 又涨价了", url: "/1/017/8.htm", postdate: "2026-10-26T07:00:00.000", hitcount: 1 },
          ],
        }),
        { status: 200 },
      );
    }
    if (url.includes("ithome.com/rss")) return new Response("<rss><channel></channel></rss>", { status: 200 });
    return new Response(JSON.stringify({ data: [] }), { status: 200 });
  }) as typeof fetch;
  const beforeSources = process.env.PROBE_CN_TRENDING_SOURCES;
  const beforeServer = process.env.PROBE_CN_TRENDING_SERVER;
  delete process.env.PROBE_CN_TRENDING_SOURCES;
  delete process.env.PROBE_CN_TRENDING_SERVER;
  __testResetCnCache();
  try {
    const snap = await getCnTrending(true);
    assert.equal(snap.topics.length, 1);
    assert.equal(snap.topics[0].name, "台积电");
    assert.equal(snap.topics[0].articles24h, 2);
    assert.equal(snap.topics[0].status, undefined, "基线空的时候没有状态标签");
    assert.equal(snap.topics[0].spark, undefined);
    assert.ok(snap.degraded.includes("cn:baseline_empty"));

    const callsAfterFirst = calls;
    await getCnTrending();
    assert.equal(calls, callsAfterFirst, "缓存期内不许再打上游");
  } finally {
    globalThis.fetch = realFetch;
    if (beforeSources !== undefined) process.env.PROBE_CN_TRENDING_SOURCES = beforeSources;
    if (beforeServer !== undefined) process.env.PROBE_CN_TRENDING_SERVER = beforeServer;
    __testResetCnCache();
  }
});

test("开关：PROBE_CN_TRENDING_SERVER=0 时整块关掉", () => {
  const before = process.env.PROBE_CN_TRENDING_SERVER;
  try {
    process.env.PROBE_CN_TRENDING_SERVER = "0";
    assert.equal(cnTrendingEnabled(), false);
    process.env.PROBE_CN_TRENDING_SERVER = "1";
    assert.equal(cnTrendingEnabled(), true);
    delete process.env.PROBE_CN_TRENDING_SERVER;
    assert.equal(cnTrendingEnabled(), true, "默认开");
  } finally {
    if (before === undefined) delete process.env.PROBE_CN_TRENDING_SERVER;
    else process.env.PROBE_CN_TRENDING_SERVER = before;
  }
});
