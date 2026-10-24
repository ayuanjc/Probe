
import { z } from "zod";
import { ClaimSchema, DatasetSchema } from "@/lib/schemas";
import type { Claim, Confidence, Dataset, Intent, RawSource } from "@/lib/schemas";
import {
  computeConfidence,
  findSyndicatedIds,
  allowsAggregateNumbers,
  ownerOf,
} from "@/lib/confidence";
import { generateStructured, llmEnabled } from "@/lib/llm";
import type { UsageSink } from "@/lib/metrics";
import { toneBucket } from "@/lib/heat";
import { jaccard, tokenize } from "@/lib/text";
import { titleTerms } from "@/lib/entity-graph";

/**
 * 分析层：去重 → 抽取 → 聚合。三条硬规则：
 *   1. 没有 quote 的 claim 直接丢弃（不可溯源等于没有）；
 *   2. 聚合数字只在 confidence.band !== "low" 时产出；
 *   3. 缺失就是缺失，不补 0 —— rows 里宁可少一行。
 */

export type AnalysisResult = {
  sources: RawSource[];
  syndicatedIds: string[];
  claims: Claim[];
  datasets: Dataset[];
  confidence: Confidence;
  degraded: string[];
  notes: string[];
};

type DedupeResult = {
  kept: RawSource[];
  /** 因 URL/标题重复而合并掉的条数。这个数才是"去重合并"该报的量。 */
  merged: number;
  /** 连 URL 都没有、根本进不了去重流程的条数。它们不算"被合并"。 */
  dropped: number;
  /** 被合并掉的条目 id：置信度层要用它把一手性的分母还原成原始条数。 */
  mergedIds: string[];
  /** 被丢弃的条目 id（同样不算一手）。 */
  droppedIds: string[];
};

/** 标题近似判重阈值：高于它就是同一稿件的转载。 */
const TITLE_DUP = 0.92;

/**
 * 标题按「token 数的对数」分桶。
 *
 * 每对标题都重新切词是 O(n²·tokens)，而 Jaccard > 0.92 要求两边 token 数几乎相等
 * （交集不可能大于较短的那一边，所以 min/max 至少 0.92）。于是只需要与自己这一桶
 * 以及左右相邻的一桶比 —— 桶宽是 1.41 倍，正好覆盖这个容差，结果与全量两两比较一致，
 * 比较次数从 n² 降到 n×每桶条数。
 */
function bucketOf(tokenCount: number): number {
  return Math.floor(Math.log2(Math.max(1, tokenCount)) * 2);
}

function dedupe(sources: RawSource[]): DedupeResult {
  const seenUrl = new Set<string>();
  const buckets = new Map<number, Set<string>[]>();
  const out: RawSource[] = [];
  let merged = 0;
  let dropped = 0;
  const mergedIds: string[] = [];
  const droppedIds: string[] = [];

  for (const s of sources) {
    const key = (s.canonical ?? s.url).replace(/[?#].*$/, "").replace(/\/$/, "");
    if (!key) {
      dropped++;
      droppedIds.push(s.id);
      continue;
    }
    if (seenUrl.has(key)) {
      merged++;
      mergedIds.push(s.id);
      continue;
    }

    // 跨源标题几乎一致 → 视为同一稿件的转载，只保留第一条。
    const tokens = tokenize(s.title);
    if (tokens.size > 0) {
      const b = bucketOf(tokens.size);
      let dup = false;
      for (const bb of [b - 1, b, b + 1]) {
        const list = buckets.get(bb);
        if (!list) continue;
        if (list.some((t) => jaccard(t, tokens) > TITLE_DUP)) {
          dup = true;
          break;
        }
      }
      if (dup) {
        merged++;
        mergedIds.push(s.id);
        continue;
      }
      const list = buckets.get(b);
      if (list) list.push(tokens);
      else buckets.set(b, [tokens]);
    }

    seenUrl.add(key);
    out.push(s);
  }
  return { kept: out, merged, dropped, mergedIds, droppedIds };
}

async function extractClaims(
  intent: Intent,
  sources: RawSource[],
  sink?: UsageSink,
): Promise<{ claims: Claim[]; source: "llm" | "fixture" | "none" }> {
  if (sources.length === 0) return { claims: [], source: "none" };

  /**
   * 没有模型就不抽断言。这里曾经回落成模板生成的假 claim，
   * 于是界面上会冒出"可核验断言 2"——两句谁也没说过的引用。
   * 宁可这一栏空着，也不能凭空造出可以点开核对的证据。
   */
  if (!llmEnabled()) {
    return { claims: [], source: "none" };
  }

  const bundle = sources.slice(0, 12).map((s) => ({
    id: s.id,
    title: s.title,
    snippet: s.snippet.slice(0, 300),
    publishedAt: s.publishedAt,
  }));

  const parsed = await generateStructured<{ claims: Claim[] }>({
    schema: ClaimLike,
    system:
      "从给定材料中抽取可核验的事实断言。规则：" +
      "每个 claim 必须带 quote（原文逐字片段）与 sourceIds（只能是输入里出现过的 id）；" +
      "数字类断言必须带 unit；找不到原文支撑就不要输出该 claim；" +
      "不要推理、不要补充材料里没有的信息。" +
      "\n每条 claim 必须带 kind，按优先序取第一个命中的：" +
      "prediction > causal > opinion > quantitative > temporal > attribution > existence。" +
      "prediction=未来指向（将/预计/有望/计划/目标）；causal=因果（导致/因为/推动/带动/使得）；" +
      "opinion=评价或模糊程度（显著/看好/糟糕/值得/优于同行）；" +
      "quantitative=数值带单位或比率/金额/份额/排名/增幅；temporal=日期/时点/期限/持续时长；" +
      "attribution=谁说了/谁做的/谁拥有/谁任命；existence=存在/上线/下架/具备某功能（无数字无时点）。" +
      "带数字但含未来指向或因果的，分别记 prediction / causal，不要记 quantitative。",
    prompt:
      "查询：" + intent.query + "\n材料：\n" + JSON.stringify(bundle, null, 1),
  }, sink);

  if (!parsed) return { claims: [], source: "none" };

  const validIds = new Set(sources.map((s) => s.id));
  /**
   * 只要求"有一个合法 id"是不够的：夹带伪造 id 的 claim 会保留下来，
   * 而下游（confidence 的一致性比对、转载排除）会按 sourceIds 里的每一项去查，
   * 伪造的那条既查不到也不报错，等于悄悄污染了核验口径。
   * 先裁到合法 id，裁空就整条丢掉 —— 没有出处的事实不是事实。
   */
  const claims: Claim[] = [];
  for (const c of parsed.claims) {
    if (!c.quote || c.quote.trim().length < 4) continue;
    const ids = c.sourceIds.filter((id) => validIds.has(id));
    if (ids.length === 0) continue;
    claims.push({ ...c, sourceIds: ids });
  }

  return { claims, source: "llm" };
}

/** 模型返回 { claims: [...] }，逐项过 ClaimSchema。 */
const ClaimLike = z.object({ claims: z.array(ClaimSchema) });

/**
 * 按 Asia/Hong_Kong 落日期，不用 toISOString()。
 * UTC 落日期时，用户晚上八点后看到的新闻会被归到前一天的柱子上，
 * 时间线的形状本身就是错的——而这是页面最显眼的那个模块。
 */
const DAY_FMT = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Hong_Kong",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

function dayKey(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "unknown";
  return DAY_FMT.format(d);
}
/** 星期与小时也从香港时区落。用 UTC 的话，本地周一早上八点会掉进周日晚。 */
const WD_FMT = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Hong_Kong", weekday: "short" });
const HR_FMT = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Hong_Kong", hour: "2-digit", hour12: false });
const WD_INDEX: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const WD_NAME = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

function hourParts(iso: string): { wd: number; hour: number } | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const wd = WD_INDEX[WD_FMT.format(d)];
  const h = Number(HR_FMT.format(d));
  if (wd === undefined || !Number.isFinite(h)) return null;
  // en-US 的 hour12:false 在午夜给的是 24，不是 0。
  return { wd, hour: ((h % 24) + 24) % 24 };
}

export async function analyze(
  intent: Intent,
  raw: RawSource[],
  sink?: UsageSink,
): Promise<AnalysisResult> {
  const notes: string[] = [];
  const degraded: string[] = [];

  const deduped = dedupe(raw);
  const sources = deduped.kept;
  /**
   * 转载判定必须在**原始集合**上跑（CODE-REVIEW #5）。
   *
   * 这一步原本写在 dedupe 之后：dedupe 用 0.92 的标题阈值先吃掉了全部高相似对，
   * 而 findSyndicatedIds 的阈值是 0.9 / 0.8 —— 存活集合里只剩一条窄带能命中，
   * 于是「疑似转载」长期恒为 0、firstHand 恒约等于 1，0.4 的权重白送。
   * 现在两头都补：池子取自原始集合（并入被合并掉的条目），分母取原始条数。
   * 这样 「原始 40 / 存活 9 / 转载 31」 才是一个能被界面对上的三元组。
   */
  const syndicatedSet = findSyndicatedIds(raw);
  for (const id of deduped.mergedIds) syndicatedSet.add(id);
  const syndicatedIds = [...syndicatedSet];
  const { claims, source: claimSource } = await extractClaims(intent, sources, sink);
  if (claimSource === "none") degraded.push("claims:off");

  const confidence = computeConfidence(sources, claims, {
    rawCount: raw.length,
    syndicatedIds,
    mergedIds: deduped.mergedIds,
  });
  const allowNumbers = allowsAggregateNumbers(confidence);
  const datasets: Dataset[] = [];

  const countDays = new Map<string, number>();
  for (const s of sources) {
    const k = dayKey(s.publishedAt);
    countDays.set(k, (countDays.get(k) ?? 0) + 1);
  }
  const dayRows = [...countDays.entries()]
    .filter(([k]) => k !== "unknown")
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([day, articles]) => ({ day, articles }));

  if (dayRows.length >= 2) {
    datasets.push({
      id: "ds-timeline",
      name: "按日文章数",
      unit: "篇",
      fields: [
        { name: "day", type: "time" },
        { name: "articles", type: "number", unit: "篇" },
      ],
      rows: dayRows,
    });
  }

  /**
   * 时间形状的原始统计（星期×小时、星期分布、24h 新鲜度、时距×情感）。
   * 必须放在 allowNumbers 判断之前算：低置信时这几张图不出，
   * 但"有发布时间 / 24h 内"这两级漏斗是条目自身的属性，与置信度无关。
   */
  const hourCells = new Map<number, number>();
  const weekdayCount = new Array<number>(7).fill(0);
  const tonePoints: { hours: number; tone: number }[] = [];
  const nowMs = Date.now();
  let dated = 0;
  let fresh = 0;
  for (const s of sources) {
    const p = hourParts(s.publishedAt);
    if (!p) continue;
    dated++;
    const cell = p.wd * 24 + p.hour;
    hourCells.set(cell, (hourCells.get(cell) ?? 0) + 1);
    weekdayCount[p.wd]++;
    const age = (nowMs - new Date(s.publishedAt).getTime()) / 3_600_000;
    if (age >= 0 && age <= 24) fresh++;
    // NaN 也是 "number"：上游给坏值时它会一路变成 null 落进 ECharts。
    if (typeof s.tone === "number" && Number.isFinite(s.tone) && age >= 0 && age <= 24 * 7) {
      tonePoints.push({ hours: Math.round(age * 10) / 10, tone: s.tone });
    }
  }

  if (allowNumbers) {
    // 必须走 ownerOf()，和 computeConfidence 里 nOwners 用同一个口径。
    // 这里曾直接用 s.owner：owner 为空或大小写不同时，
    // 柱状图的分组数和 KPI 的"独立信源"数会对不上，违反"数字一一对应"。
    const countOwners = new Map<string, number>();
    for (const s of sources) {
      const k = ownerOf(s);
      countOwners.set(k, (countOwners.get(k) ?? 0) + 1);
    }
    // 尾部不能直接丢：截断后各柱相加必须仍等于总条数，
    // 否则"信源分布"和 KPI 的数字会互相打脸。
    const sortedOwners = [...countOwners.entries()].sort((a, b) => b[1] - a[1]);
    const TOP_OWNERS = 7;
    const ownerRows: { owner: string; articles: number }[] = sortedOwners
      .slice(0, TOP_OWNERS)
      .map(([owner, articles]) => ({ owner, articles }));
    // 阈值是 TOP_OWNERS 而不是 TOP_OWNERS + 1：恰好 8 家时第 8 家既没进表、
    // 也没被算进"其他"，各柱相加就小于总条数了。
    if (sortedOwners.length > TOP_OWNERS) {
      const rest = sortedOwners.slice(TOP_OWNERS);
      ownerRows.push({
        owner: "其他 " + rest.length + " 家",
        articles: rest.reduce((sum, [, n]) => sum + n, 0),
      });
    }

    if (ownerRows.length >= 2) {
      datasets.push({
        id: "ds-owners",
        name: "信源分布",
        unit: "篇",
        fields: [
          { name: "owner", type: "string" },
          { name: "articles", type: "number", unit: "篇" },
        ],
        rows: ownerRows,
      });
    }

    const tone = { positive: 0, neutral: 0, negative: 0 };
    for (const s of sources) {
      if (typeof s.tone === "number") tone[toneBucket(s.tone)]++;
    }
    const toneRows = Object.entries(tone)
      .filter(([, n]) => n > 0)
      .map(([bucket, articles]) => ({ bucket, articles }));

    if (toneRows.length >= 2 && toneRows.length <= 8) {
      datasets.push({
        id: "ds-tone",
        name: "情感分布",
        unit: "篇",
        fields: [
          { name: "bucket", type: "string" },
          { name: "articles", type: "number", unit: "篇" },
        ],
        rows: toneRows,
      });
    }

    // —— 标题专名共现网络 ——
    const termCount = new Map<string, number>();
    const perSourceTerms: string[][] = [];
    for (const s of sources) {
      const terms = titleTerms(s.title);
      perSourceTerms.push(terms);
      for (const t of terms) termCount.set(t, (termCount.get(t) ?? 0) + 1);
    }
    const topTerms = [...termCount.entries()]
      .filter(([, n]) => n >= 3)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 9)
      .map(([t]) => t);
    if (topTerms.length >= 4) {
      const keep = new Set(topTerms);
      const pairs = new Map<string, number>();
      for (const terms of perSourceTerms) {
        const hit = terms.filter((t) => keep.has(t));
        for (let i = 0; i < hit.length; i++) {
          for (let j = i + 1; j < hit.length; j++) {
            const a = hit[i] < hit[j] ? hit[i] : hit[j];
            const b = hit[i] < hit[j] ? hit[j] : hit[i];
            const k = a + " || " + b;
            pairs.set(k, (pairs.get(k) ?? 0) + 1);
          }
        }
      }
      const edgeRows = [...pairs.entries()]
        .filter(([, w]) => w >= 2)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 28)
        .map(([k, weight]) => {
          const parts = k.split(" || ");
          return { from: parts[0], to: parts[1], weight };
        });
      // 边太少时这张图只是几根散线，不如不出。
      if (edgeRows.length >= 3) {
        datasets.push({
          id: "ds-terms",
          name: "标题专名共现",
          fields: [
            { name: "from", type: "string" },
            { name: "to", type: "string" },
            { name: "weight", type: "number" },
          ],
          rows: edgeRows,
        });
      }
    }

    // —— 时距 × 情感（只有 GDELT 带 tone 才出得来）——
    if (tonePoints.length >= 3) {
      datasets.push({
        id: "ds-tone-scatter",
        name: "时距与情感",
        fields: [
          { name: "hours", type: "number", unit: "小时" },
          { name: "tone", type: "number" },
        ],
        rows: tonePoints.slice(0, 60),
      });
    }
  } else {
    notes.push("置信度为低档：已抑制聚合数字与分布图，仅展示可核验的原文列表。");
  }


  /**
   * 时段/星期这两张是分布图，P 档置信度下不出（与 323 行那句口径一致）。
   * 它们一度写在 allowNumbers 之外，于是"已抑制分布图"的说明旁边
   * 照样挂着两张分布图 —— 说明与事实互相打脸。
   */
  if (allowNumbers && hourCells.size >= 2) {
    datasets.push({
      id: "ds-hours",
      name: "发布时段热力图",
      unit: "篇",
      fields: [
        { name: "weekday", type: "string" },
        { name: "hour", type: "number" },
        { name: "articles", type: "number", unit: "篇" },
      ],
      rows: [...hourCells.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([cell, articles]) => ({
          weekday: WD_NAME[Math.floor(cell / 24)],
          hour: cell % 24,
          articles,
        })),
    });
  }

  const weekdayRows = weekdayCount
    .map((articles, wd) => ({ weekday: WD_NAME[wd], articles }))
    .filter((r) => r.articles > 0);
  if (allowNumbers && weekdayRows.length >= 3) {
    datasets.push({
      id: "ds-weekday",
      name: "星期分布",
      unit: "篇",
      fields: [
        { name: "weekday", type: "string" },
        { name: "articles", type: "number", unit: "篇" },
      ],
      rows: weekdayRows,
    });
  }

  /**
   * 漏斗只画「单调收窄」的链路，四级都有严格包含关系：
   * fresh ⊆ dated ⊆ sources ⊆ raw，所以这张图不可能自相矛盾。
   * 断言数不进来：claim 可以来自没有发布时间的条目，放进来会破坏包含关系。
   */
  // 首级必须叫"原始命中"：ds-summary 里另有一个"条目数"取的是去重后的值，
  // 两个同名标签配两个不同数字，读的人只会问哪个对。
  const flowRows = [
    { stage: "原始命中", articles: raw.length },
    { stage: "去重后", articles: sources.length },
    { stage: "有发布时间", articles: dated },
    ...(fresh > 0 ? [{ stage: "24h 内", articles: fresh }] : []),
  ];
  if (dated > 0 && flowRows.length >= 2) {
    datasets.push({
      id: "ds-flow",
      name: "检索收敛漏斗",
      unit: "篇",
      fields: [
        { name: "stage", type: "string" },
        { name: "articles", type: "number", unit: "篇" },
      ],
      rows: flowRows,
    });
  }

  if (dated > 0) {
    datasets.push({
      id: "ds-fresh",
      name: "24 小时新鲜度",
      unit: "%",
      fields: [
        { name: "label", type: "string" },
        { name: "percent", type: "number", unit: "%" },
      ],
      rows: [{ label: "24h 内", percent: Math.round((fresh / dated) * 1000) / 10 }],
    });
  }

  /**
   * KPI 里混着两种东西：条目计数（每一条都能在下面的列表里点开核对）
   * 与派生统计（独立信源、疑似转载 —— 都是推断出来的）。
   * 低置信时只留前者：把数得清的东西藏起来没有意义，
   * 但把推断当数字印上去，就违反了"低档不出聚合数字"。
   */
  const summaryRows: { label: string; value: number }[] = [
    { label: "条目数", value: sources.length },
    ...(deduped.merged > 0 ? [{ label: "去重合并", value: deduped.merged }] : []),
    ...(deduped.dropped > 0 ? [{ label: "无链接跳过", value: deduped.dropped }] : []),
  ];
  if (allowNumbers) {
    summaryRows.push({ label: "独立信源", value: confidence.nOwners });
    summaryRows.push({ label: "疑似转载", value: syndicatedIds.length });
    // 抽到 0 条就不显示这一栏：KPI 里的 0 会被读成"确实没有事实"，
    // 而真相是这一轮根本没有做抽取。缺失的东西不占数字位。
    if (claims.length > 0) summaryRows.push({ label: "可核验断言", value: claims.length });
  }
  datasets.push({
    id: "ds-summary",
    name: "本次检索概况",
    fields: [
      { name: "label", type: "string" },
      { name: "value", type: "number" },
    ],
    rows: summaryRows,
  });

  notes.push("口径说明：文章数指本次检索命中的条目，不是全网总量。");
  if (!allowNumbers) {
    notes.push(
      "低置信档只抑制派生统计（独立信源、疑似转载、可核验断言），条目计数照常 —— 每一条都能在下面的列表里点开核对。",
    );
  }
  if (confidence.nChecked === 0) {
    notes.push(
      "本轮没有可交叉核对的断言：置信度不含一致性证据，已封顶 0.64（" +
        (claimSource === "none" ? "未配置模型 key，抽取未运行。" : "抽到的断言没有两条以上独立来源对得上。") +
        "）",
    );
  }
  if (deduped.merged > 0) {
    notes.push(
      "去掉了 " + deduped.merged + " 条重复或疑似转载条目（同 URL 或标题相似度 > 0.92），保留的是各来源里最完整的那一条。",
    );
  }
  if (syndicatedIds.length > 0) {
    // 把算式写出来，而不是只说「一手性 0.23」：看到分子分母才能判断这个数可信不可信。
    notes.push(
      "一手性 = 1 − 疑似转载 / 原始命中 = 1 − " +
        syndicatedIds.length +
        " / " +
        raw.length +
        " = " +
        confidence.firstHand.toFixed(2) +
        "；转载判定在去重之前做，否则被标题相似度合并掉的条目会整批漏计。",
    );
  }

  /**
   * 出口自检：rows 里的 NaN/Infinity 经 JSON.stringify 会静默变成 null，
   * 而 null 在 DatasetSchema 里是合法值 —— 坏数字就这样一路走到 ECharts，
   * 既不报错也不显示，图只是少一块。这里先剪掉非有限数字行，再按 schema 过一遍；
   * 被剪掉这件事要记进 degraded，不能悄悄发生。
   */
  const clean: Dataset[] = [];
  let badRows = 0;
  for (const ds of datasets) {
    const rows = ds.rows.filter((row) =>
      Object.values(row).every((v) => typeof v !== "number" || Number.isFinite(v)),
    );
    badRows += ds.rows.length - rows.length;
    if (rows.length === 0) continue;
    const parsed = DatasetSchema.safeParse({ ...ds, rows });
    if (!parsed.success) {
      degraded.push("dataset:invalid_" + ds.id);
      continue;
    }
    clean.push(parsed.data);
  }
  if (badRows > 0) degraded.push("rows:non_finite");

  return {
    sources,
    syndicatedIds,
    claims,
    datasets: clean,
    confidence,
    degraded,
    notes,
  };
}