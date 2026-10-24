import type { RawSource } from "@/lib/schemas";
import { ALIASES } from "@/lib/entities";

/**
 * 实体关系图：从本轮信源抽实体，按「同一条标题里一起出现」建边，
 * 再按 2 跳邻域查看任一实体周围的圈子。
 *
 * 三个刻意的决定：
 *   1. 边是共现，不是语义关系。界面上写「共同出现」，不写「相关」——
 *      同一行标题里出现两个名字，只能说明有人把它们写在一起，说明不了因果。
 *   2. 词典命中走词边界匹配（(?<![A-Za-z0-9])…），不用 includes。
 *      词典里 "meta" / "eu" 这类短别名用 includes 会命中 metadata / europe，
 *      凭空造出一个假枢纽。
 *   3. 图在本轮结果里，不是持久知识库。PRD 写的是 Postgres 邻接表 + pgvector，
 *      仓库没有数据库；这里用内存邻接表提供同一套「2 跳查询」，
 *      将来换存储层只替换 buildEntityGraph 的输入来源，neighborhood() 不用动。
 */

export type EntityTag = "org" | "tech" | "event" | "term";

export type EntityNode = {
  /** 归一化键（小写规范名）：同一实体的中文名与英文名共用一个 id。 */
  id: string;
  name: string;
  type: EntityTag;
  /** 提到它的信源条数。 */
  mentions: number;
  /** 证据信源 id（前 8 条）。 */
  sourceIds: string[];
};

export type EntityEdge = {
  a: string;
  b: string;
  /** 两个实体同处一条标题的次数。 */
  weight: number;
  /** 证据信源 id（前 6 条）。 */
  sourceIds: string[];
};

export type EntityGraph = {
  nodes: EntityNode[];
  edges: EntityEdge[];
  /** 参与构图的信源条数。 */
  sourceCount: number;
  builtFrom: "title+snippet";
};

export type Neighborhood = {
  center: string;
  /** id → 跳数（0 是中心，1/2 是邻居）。 */
  hop: Record<string, number>;
  nodes: EntityNode[];
  edges: EntityEdge[];
  /** 因为节点上限被略去的邻居个数。 */
  omitted: number;
};

const CJK = /[\u4e00-\u9fa5]/;
const ASCII = /^[\x20-\x7e]+$/;

export function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hasTerm(text: string, term: string): boolean {
  if (!term.trim()) return false;
  // 中文别名没有词边界，直接找子串；英文必须卡边界，否则 meta 会命中 metadata。
  if (!ASCII.test(term)) return text.includes(term);
  return new RegExp("(?<![A-Za-z0-9])" + escapeRe(term) + "(?![A-Za-z0-9])", "i").test(text);
}

/**
 * 标题里的专名候选：连续大写开头的词串（Nvidia / Hacker News / GPT-5）。
 * 句首普通大写字会抽出噪声，交给「至少被两条信源提到」这道闸筛。
 */
export const TERM_STOP = new Set([
  "The", "A", "An", "In", "On", "At", "For", "And", "But", "How", "Why", "What", "New",
  "This", "That", "It", "Is", "Are", "To", "Of", "With", "From", "After", "Before", "As",
  "By", "Not", "No", "Its", "His", "Her", "Their", "We", "You", "They", "My", "Our", "More",
  "Most", "Some", "One", "Two", "Three", "Best", "Top", "When", "Where", "Who", "Which", "Just",
  "Now", "Still", "Even", "Only", "Also", "Can", "Could", "Should", "Would", "Will", "Has", "Have",
  // HN 惯用前缀与发布噪声：这些词在标题里高频，但它们不是实体。
  "Show", "Ask", "Tell", "Launch", "Pro", "Max", "Plus", "Update", "Release", "Week", "Day",
  "Year", "Month", "Today", "Part", "Guide", "Notes", "Blog", "Post", "Video", "Story", "Review",
  "Announcing", "Announcement", "Thoughts", "Lessons", "Using", "Built", "Making", "Made", "Why Not",
  // 站点名：HN 的标题里到处都是，但它不是新闻里的实体。
  "HN",
]);

/**
 * 多词专名只要首词是功能词或发布噪声，整串就不是实体：
 * 「Show HN」「Ask HN」「Launch Week」都会被这条挡掉，而「Hacker News」保留。
 */
function noiseName(term: string): boolean {
  return TERM_STOP.has(term.split(/\s+/)[0]);
}

export function titleTerms(title: string): string[] {
  const found = title.match(/[A-Z][A-Za-z0-9]*(?:[ .+-][A-Z][A-Za-z0-9]*)*/g) ?? [];
  const out = new Set<string>();
  for (const rawTerm of found) {
    const term = rawTerm.replace(/[ .,]+$/, "").trim();
    if (term.length < 2 || term.length > 26) continue;
    if (TERM_STOP.has(term) || noiseName(term)) continue;
    out.add(term);
  }
  return [...out];
}

function tagOf(t: string): EntityTag {
  if (t === "org" || t === "tech" || t === "event") return t;
  return "term";
}

/**
 * 词典里的展示名：中文界面优先中文别名；纯技术词（Rust / Linux / OpenAI）没有中文名，
 * 用规范英文写法，否则界面上会出现「rust」。
 */
function displayName(a: (typeof ALIASES)[number]): string {
  const first = a.zh[0] ?? "";
  return CJK.test(first) ? first : a.en;
}

const DICT = ALIASES.map((a) => ({
  id: a.en.toLowerCase(),
  name: displayName(a),
  type: tagOf(a.type),
  terms: [...a.zh, a.en],
}));

/** 词典命中的实体 id（查询词也走这一套，所以「问什么」与「图里有什么」用同一批名字）。 */
export function dictIdsIn(text: string): string[] {
  const out: string[] = [];
  for (const d of DICT) {
    if (d.terms.some((t) => hasTerm(text, t))) out.push(d.id);
  }
  return out;
}

/**
 * 英文专名的形状规则。标题里光靠「大写开头」不够：
 * 「Pro」「Max」「Show HN」都符合大写，但它们是发布噪声。
 * 这里要求至少满足一条：含数字（GPT-5 / 3.11）、词内有大写（AfD / iOS）、
 * 单词长度 ≥ 5（Dutch / German），或者多词（Hacker News）。
 */
function plausibleName(term: string): boolean {
  if (term.length < 3) return false;
  if (term.includes(" ") || term.includes("-") || term.includes(".")) return true;
  if (/\d/.test(term)) return true;
  if (/[A-Z]/.test(term.slice(1))) return true;
  return term.length >= 5;
}

type Acc = { name: string; type: EntityTag; sourceIds: Set<string>; dict: boolean };

export type GraphBuild = { graph: EntityGraph | null; why?: string };

/** 节点 / 边上限：图是给人看的，不是要画完所有连线的。 */
export const MAX_NODES = 24;
export const MAX_EDGES = 40;
/** 一个实体至少被两条信源提到才算「主干」。 */
export const MIN_ENTITY_SOURCES = 2;
/**
 * 边权下限是 1，不是 2。本轮信源通常只有二十几条，两次共现是很高的门槛 ——
 * 卡在 2 会让大多数真实查询一张图都出不来。只同现一次的边照样画，
 * 但界面上用虚线灰线，语义是「候选关系」，不当结论。
 */
export const MIN_EDGE_WEIGHT = 1;
const MAX_EVIDENCE_NODE = 8;
const MAX_EVIDENCE_EDGE = 6;

export function buildEntityGraph(sources: RawSource[], query: string): GraphBuild {
  if (sources.length < 4) {
    return { graph: null, why: "信源只有 " + sources.length + " 条，连不出关系网。" };
  }

  const acc = new Map<string, Acc>();
  const perSource: { sourceId: string; ids: string[] }[] = [];

  const bump = (id: string, name: string, type: EntityTag, sourceId: string, dict: boolean) => {
    const a = acc.get(id);
    if (a) {
      a.sourceIds.add(sourceId);
      if (dict) a.dict = true;
      // 先命中的名字可能是专名（小写 id），词典的规范名更可靠，后到就用后到的。
      if (type !== "term") a.name = name;
      return;
    }
    acc.set(id, { name, type, sourceIds: new Set([sourceId]), dict });
  };

  for (const s of sources) {
    const ids = new Set<string>();
    const dictText = s.title + " " + s.snippet;
    for (const d of DICT) {
      if (!d.terms.some((t) => hasTerm(dictText, t))) continue;
      ids.add(d.id);
      bump(d.id, d.name, d.type, s.id, true);
    }
    // 专名只看标题：snippet 里句首的大写词太多，那部分噪声不该进图。
    for (const term of titleTerms(s.title)) {
      const id = term.toLowerCase();
      if (ids.has(id)) continue;
      if (!CJK.test(term) && !plausibleName(term)) continue;
      // 「Kimi K3」这种「词典词 + 型号」的写法：认出词头就归到同一个实体，
      // 否则图里会出现「Kimi K3 — Moonshot AI」这种自己连自己的边。
      const head = term.split(/[\s.+-]/)[0];
      if (!CJK.test(head) && dictIdsIn(head).length > 0) continue;
      ids.add(id);
      bump(id, term, "term", s.id, false);
    }
    perSource.push({ sourceId: s.id, ids: [...ids] });
  }

  const queryIds = dictIdsIn(query);
  /**
   * 主干实体：被两条以上信源提到的，加上用户点名的。
   * 只出现一次的实体不是没有信息 —— 一条标题里「OpenAI 与微软」同现，这个连接是真的。
   * 但它们数量多（句首大写词、一次性产品名），全放进来图就变成毛球。
   * 折中：只出现一次的实体必须同时满足两条 —— 在词典里（机构/技术/事件），
   * 并且连到了某个主干实体 —— 才带进图。
   */
  const trunk = [...acc.entries()].filter(
    ([id, a]) => a.sourceIds.size >= MIN_ENTITY_SOURCES || queryIds.includes(id),
  );
  if (trunk.length < 4) {
    return { graph: null, why: "进入统计的实体只有 " + trunk.length + " 个，至少 4 个才连得成网。" };
  }

  // 查询实体优先保位，其余按被提到条数排序。
  trunk.sort((x, y) => {
    const qx = queryIds.includes(x[0]) ? 1 : 0;
    const qy = queryIds.includes(y[0]) ? 1 : 0;
    if (qx !== qy) return qy - qx;
    return y[1].sourceIds.size - x[1].sourceIds.size;
  });
  const base = trunk.slice(0, MAX_NODES);
  const baseIds = new Set(base.map(([id]) => id));

  const edgeAcc = new Map<string, { weight: number; sourceIds: string[] }>();
  const extraIds = new Map<string, number>();

  for (const row of perSource) {
    const ids = [...row.ids].sort();
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const a = ids[i];
        const b = ids[j];
        const inA = baseIds.has(a);
        const inB = baseIds.has(b);
        if (!inA && !inB) continue;
        // 非主干的那一端必须是词典实体，否则就是一次性的标题噪声。
        if (!inA && !acc.get(a)?.dict) continue;
        if (!inB && !acc.get(b)?.dict) continue;
        const k = a + "\u0000" + b;
        const e = edgeAcc.get(k) ?? { weight: 0, sourceIds: [] };
        e.weight += 1;
        if (e.sourceIds.length < MAX_EVIDENCE_EDGE) e.sourceIds.push(row.sourceId);
        edgeAcc.set(k, e);
        if (!inA) extraIds.set(a, (extraIds.get(a) ?? 0) + 1);
        if (!inB) extraIds.set(b, (extraIds.get(b) ?? 0) + 1);
      }
    }
  }

  // 名额：主干优先，剩下的按共现次数分给「只出现一次的词典实体」。
  const room = Math.max(0, MAX_NODES - baseIds.size);
  const extras = [...extraIds.entries()]
    .filter(([id]) => !baseIds.has(id))
    .sort((x, y) => y[1] - x[1])
    .slice(0, room)
    .map(([id]) => id);
  const nodeIds = new Set([...baseIds, ...extras]);

  const edges: EntityEdge[] = [...edgeAcc.entries()]
    .map(([k, v]) => {
      const cut = k.indexOf("\u0000");
      return { a: k.slice(0, cut), b: k.slice(cut + 1), weight: v.weight, sourceIds: v.sourceIds };
    })
    .filter((e) => e.weight >= MIN_EDGE_WEIGHT && nodeIds.has(e.a) && nodeIds.has(e.b))
    .sort((x, y) => y.weight - x.weight)
    .slice(0, MAX_EDGES);

  if (edges.length < 3) {
    return {
      graph: null,
      why: "实体之间只有 " + edges.length + " 条共现（至少 3 条才看得出结构）。",
    };
  }

  const nodes: EntityNode[] = [];
  for (const id of nodeIds) {
    const a = acc.get(id);
    if (!a) continue;
    nodes.push({
      id,
      name: a.name,
      type: a.type,
      mentions: a.sourceIds.size,
      sourceIds: [...a.sourceIds].slice(0, MAX_EVIDENCE_NODE),
    });
  }

  return { graph: { nodes, edges, sourceCount: sources.length, builtFrom: "title+snippet" } };
}

/** 每个节点的度数（连出去几条边）。用来判断谁是枢纽。 */
export function degrees(graph: EntityGraph): Map<string, number> {
  const d = new Map<string, number>();
  for (const e of graph.edges) {
    d.set(e.a, (d.get(e.a) ?? 0) + 1);
    d.set(e.b, (d.get(e.b) ?? 0) + 1);
  }
  return d;
}

/**
 * 2 跳邻域：从 center 出发按层扩展，同一层里先走强边。
 * PRD 的 pgvector 版本是「向量近邻 2 跳」，这里换成「共现边 2 跳」——
 * 因为本轮没有 embedding，硬假装有就是在编。
 */
export function neighborhood(
  graph: EntityGraph,
  centerId: string,
  hops = 2,
  maxNodes = 18,
): Neighborhood {
  const adj = new Map<string, { id: string; weight: number }[]>();
  const link = (from: string, to: string, weight: number) => {
    const list = adj.get(from);
    if (list) list.push({ id: to, weight });
    else adj.set(from, [{ id: to, weight }]);
  };
  for (const e of graph.edges) {
    link(e.a, e.b, e.weight);
    link(e.b, e.a, e.weight);
  }

  const hop = new Map<string, number>([[centerId, 0]]);
  const omittedIds = new Set<string>();
  let frontier = [centerId];

  for (let h = 1; h <= hops; h++) {
    const next: string[] = [];
    for (const cur of frontier) {
      const arms = (adj.get(cur) ?? []).slice().sort((x, y) => y.weight - x.weight);
      for (const arm of arms) {
        if (hop.has(arm.id)) continue;
        if (hop.size >= maxNodes) {
          omittedIds.add(arm.id);
          continue;
        }
        hop.set(arm.id, h);
        next.push(arm.id);
      }
    }
    if (next.length === 0) break;
    frontier = next;
  }

  const ids = new Set(hop.keys());
  return {
    center: centerId,
    hop: Object.fromEntries(hop),
    nodes: graph.nodes.filter((n) => ids.has(n.id)),
    edges: graph.edges.filter((e) => ids.has(e.a) && ids.has(e.b)),
    omitted: omittedIds.size,
  };
}
