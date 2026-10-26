/**
 * 国内榜单（百度热搜 / 掘金）：解析与降级。
 *
 * 每条断言对着一个会伤人的后果：
 *   - 上游字段变形就把整块榜单清零（详情页白掉）→ 遍历式解析 + 一次重试；
 *   - 把 javascript: 链接当条目渲染 → 点一下就执行别人的脚本；
 *   - 拿榜单数值冒充我们的热度分 → 「不撒谎」这条立站之本当场破功；
 *   - 每秒都去问百度 → 上游风控把我们拉黑，功能永久消失；
 *   - 掘金没给发布时间却画趋势 → 又一个凭空的结论。
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  __testResetHotlist,
  formatCount,
  getHotLists,
  hotStories,
  hotlistEnabled,
  parseBaiduBoard,
  parseJuejinRank,
} from "@/lib/hotlist";

const BAIDU = {
  success: true,
  data: {
    cards: [
      {
        component: "hotList",
        updateTime: 1792975301,
        content: [
          {
            query: "3000万豪宅跌至1000万 出入口在隧道",
            desc: "近日，南京越城天地豪宅业主维权。",
            hotScore: "7809327",
            hotChange: "same",
            appUrl: "https://www.baidu.com/s?wd=test1&sa=fyb_news",
          },
          {
            query: "武契奇承认败选",
            hotScore: "7713265",
            hotChange: "up",
            rawUrl: "https://www.baidu.com/s?wd=test2",
          },
        ],
      },
    ],
  },
};

const JUEJIN = {
  err_no: 0,
  data: [
    {
      content: { content_id: "7699414277584797734", title: "Flutter 官方表示：AI 时代代码越来越容易写" },
      content_counter: { view: 1204, like: 8, hot_rank: 639, comment_count: 4 },
    },
    {
      content: { content_id: "../../etc/passwd", title: "被污染的 id" },
      content_counter: { view: 1 },
    },
  ],
};

test("百度榜单：嵌套结构里按标题+链接认条目，名次自己排", () => {
  const entries = parseBaiduBoard(BAIDU);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].rank, 1);
  assert.equal(entries[0].title, "3000万豪宅跌至1000万 出入口在隧道");
  assert.equal(entries[0].score, 7809327);
  assert.equal(entries[0].change, "same");
  assert.equal(entries[1].rank, 2, "rank 用我们自己的顺序，不照搬上游 index");
  assert.equal(entries[1].change, "up");
  assert.equal(entries[1].host, "www.baidu.com");
});

test("百度榜单：javascript: 与 data: 链接一律丢掉（这是 XSS 入口）", () => {
  const entries = parseBaiduBoard({
    data: {
      cards: [
        {
          content: [
            { query: "恶意条目", appUrl: "javascript:alert(1)" },
            { query: "另一个", url: "data:text/html,<script>alert(1)</script>" },
            { query: "正常条目", appUrl: "https://www.baidu.com/s?wd=ok" },
          ],
        },
      ],
    },
  });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].title, "正常条目");
});

test("百度榜单：同一个链接只出现一次，结构完全不对时返回空而不是抛错", () => {
  const dup = parseBaiduBoard({
    data: {
      cards: [
        {
          content: [
            { query: "A", appUrl: "https://www.baidu.com/s?wd=x" },
            { query: "B", appUrl: "https://www.baidu.com/s?wd=x" },
          ],
        },
      ],
    },
  });
  assert.equal(dup.length, 1);
  assert.deepEqual(parseBaiduBoard(null), []);
  assert.deepEqual(parseBaiduBoard({ data: { cards: "nope" } }), []);
  assert.deepEqual(parseBaiduBoard({}), []);
});

test("掘金榜单：只认数字 id 拼出来的 URL，被污染的 id 丢掉", () => {
  const entries = parseJuejinRank(JUEJIN);
  assert.equal(entries.length, 1, "content_id 不是纯数字的那条必须被丢掉");
  assert.equal(entries[0].url, "https://juejin.cn/post/7699414277584797734");
  assert.equal(entries[0].score, 639, "有 hot_rank 就用 hot_rank");
  assert.equal(entries[0].scoreLabel, "阅读 1204");
  assert.equal(entries[0].change, undefined, "掘金不给发布时间，就不能编变化");
});

test("数字格式化：万以下原样，万以上折成「万」", () => {
  assert.equal(formatCount(0), "0");
  assert.equal(formatCount(9999), "9999");
  assert.equal(formatCount(12345), "1.2 万");
  assert.equal(formatCount(7809327), "781 万");
  assert.equal(formatCount(null), "—");
});

test("关注摊平：provider 保留源，points 就是上游数值，一条 URL 只算一次", () => {
  const stories = hotStories({
    fetchedAt: "2026-10-26T00:00:00.000Z",
    lists: [
      {
        provider: "baidu",
        label: "百度热搜",
        note: "",
        fetchedAt: "2026-10-26T00:00:00.000Z",
        entries: [
          { rank: 1, title: "台积电涨价", url: "https://www.baidu.com/s?wd=a", host: "www.baidu.com", score: 7809327, scoreLabel: "百度热度" },
        ],
      },
      {
        provider: "juejin",
        label: "掘金热榜",
        note: "",
        fetchedAt: "2026-10-26T00:00:00.000Z",
        entries: [
          { rank: 1, title: "TSMC 产能", url: "https://juejin.cn/post/7699414277584797734", host: "juejin.cn", score: 639, scoreLabel: "阅读 1204" },
          { rank: 2, title: "重复", url: "https://www.baidu.com/s?wd=a", host: "www.baidu.com", score: 1, scoreLabel: "百度热度" },
        ],
      },
    ],
    degraded: [],
  });
  assert.equal(stories.length, 2);
  assert.equal(stories[0].provider, "baidu");
  assert.equal(stories[0].points, 7809327);
  assert.equal(stories[1].provider, "juejin");
  assert.equal(stories[1].points, 639);
});

test("服务端关掉时：一个上游请求都不发，返回 disabled 而不是空榜单", async () => {
  const before = process.env.PROBE_HOTLIST_SERVER;
  process.env.PROBE_HOTLIST_SERVER = "0";
  __testResetHotlist();
  try {
    assert.equal(hotlistEnabled(), false);
    const snap = await getHotLists(true);
    assert.deepEqual(snap.lists, []);
    assert.deepEqual(snap.degraded, ["hotlist:disabled"]);
  } finally {
    if (before === undefined) delete process.env.PROBE_HOTLIST_SERVER;
    else process.env.PROBE_HOTLIST_SERVER = before;
    __testResetHotlist();
  }
});

test("抓取成功：两条源各成一块，缓存期内不再打上游", async () => {
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async (input: unknown) => {
    calls++;
    const url = String(input);
    const body = url.includes("baidu") ? BAIDU : JUEJIN;
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const before = process.env.PROBE_HOTLIST_SERVER;
  delete process.env.PROBE_HOTLIST_SERVER;
  __testResetHotlist();
  try {
    const snap = await getHotLists(true);
    assert.equal(snap.lists.length, 2);
    assert.equal(snap.lists[0].provider, "baidu");
    assert.equal(snap.lists[1].provider, "juejin");
    assert.deepEqual(snap.degraded, []);
    assert.equal(calls, 2);

    const again = await getHotLists();
    assert.equal(calls, 2, "缓存期内不许再打上游 —— 这就是对上流的限速");
    assert.equal(again.lists.length, 2);
  } finally {
    globalThis.fetch = realFetch;
    if (before !== undefined) process.env.PROBE_HOTLIST_SERVER = before;
    __testResetHotlist();
  }
});

test("抓取失败：重试一次，两次都挂才记 failed，且另一条源不受影响", async () => {
  const realFetch = globalThis.fetch;
  let baiduCalls = 0;
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    if (url.includes("baidu")) {
      baiduCalls++;
      throw new Error("boom");
    }
    return new Response(JSON.stringify(JUEJIN), { status: 200 });
  }) as typeof fetch;
  __testResetHotlist();
  try {
    const snap = await getHotLists(true);
    assert.equal(baiduCalls, 2, "一次重试：两次都失败才放弃");
    assert.equal(snap.lists.length, 1);
    assert.equal(snap.lists[0].provider, "juejin");
    assert.ok(snap.degraded.includes("baidu:failed"));
  } finally {
    globalThis.fetch = realFetch;
    __testResetHotlist();
  }
});

test("上游返回空列表：记 empty 而不是当成成功（空榜单会被缓存 15 分钟）", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    const body = url.includes("baidu") ? { data: { cards: [] } } : JUEJIN;
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
  __testResetHotlist();
  try {
    const snap = await getHotLists(true);
    assert.equal(snap.lists.length, 1);
    assert.ok(snap.degraded.includes("baidu:empty"));
  } finally {
    globalThis.fetch = realFetch;
    __testResetHotlist();
  }
});
