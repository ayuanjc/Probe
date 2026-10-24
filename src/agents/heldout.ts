/**
 * 留出集检索器：把「一条断言」变成「几条本文没引用过的外部材料」。
 *
 * 两层分工：
 *   - src/lib/heldout.ts 决定检索词与筛选规则（纯函数，可单测）；
 *   - 本文件只做网络调用，并把 search 做成可注入的 —— 这样接线逻辑（自证剔除、
 *     预算、失败路径）全都能在不联网的情况下测。
**/
import { hostOf } from "@/lib/text";
import { buildEvidenceQuery, filterHeldout } from "@/lib/heldout";
import type { HeldoutItem } from "@/lib/heldout";
import { resolvedTavilyKey } from "@/lib/runtime-config";
import type { Claim } from "@/lib/schemas";
import { ownerOfDomain } from "./retrieve";
import type { HeldoutEvidence, VerifyDeps } from "./verify";

/** 检索接口的最小形状。真实实现是 Tavily，单测里换成假函数。 */
export type HeldoutSearch = (query: string, opts: { maxResults: number }) => Promise<HeldoutItem[]>;

/** 单次检索超时。留出集检索在核验链路里是串行等待，卡住就是整轮卡住。 */
const TIMEOUT_MS = 8_000;
const DEFAULT_MAX_RESULTS = 5;

type TavilyHit = { url?: unknown; title?: unknown; content?: unknown };

/**
 * Tavily 检索。没有 key 返回 null —— 调用方拿到 null 就必须按「本轮没有留出集」处理，
 * 绝不能退化成拿本文自己的引用当证据（那是自证，吻合度会恒等于 1）。
 */
export function tavilyHeldoutSearch(key: string | undefined = resolvedTavilyKey()): HeldoutSearch | null {
  if (!key) return null;
  return async (query, opts) => {
    const res = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        // 新版账号只认 header，body 里的 api_key 已废弃（与 retrieve.ts 保持一致）。
        authorization: "Bearer " + key,
      },
      body: JSON.stringify({
        query,
        search_depth: "basic",
        max_results: Math.max(1, opts.maxResults),
        include_raw_content: false,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: "no-store",
    });
    if (!res.ok) throw new Error("tavily " + res.status);
    const json = (await res.json()) as { results?: TavilyHit[] };
    const rows = Array.isArray(json.results) ? json.results : [];
    const out: HeldoutItem[] = [];
    rows.forEach((r, i) => {
      const url = typeof r.url === "string" ? r.url : "";
      if (!url) return;
      const domain = hostOf(url);
      out.push({
        id: "held-" + i,
        url,
        owner: ownerOfDomain(domain),
        title: (typeof r.title === "string" ? r.title : url).slice(0, 200),
        text: typeof r.content === "string" ? r.content : "",
      });
    });
    return out;
  };
}

export type RetrieverOptions = {
  search: HeldoutSearch;
  /** 本文引用过的 owner：命中即剔，自证不算证据。 */
  citedOwners?: readonly string[];
  maxResults?: number;
  maxPerClaim?: number;
};

/**
 * 造一个 findEvidence。检索抛错时直接往上抛（verify.ts 会记 find_failed 并继续），
 * 不在这里吞掉 —— 吞掉的话「检索全挂了」和「留出集确实为空」会变成同一种结果，
 * 而前者是可修的故障，后者是数据的事实。
 */
export function makeHeldoutRetriever(opts: RetrieverOptions): VerifyDeps["findEvidence"] {
  const maxResults = Math.max(1, opts.maxResults ?? DEFAULT_MAX_RESULTS);
  return async (claim: Claim) => {
    const query = buildEvidenceQuery(claim);
    if (!query) return [];
    const rows = await opts.search(query, { maxResults });
    return filterHeldout(rows, opts.citedOwners ?? [], {
      maxPerClaim: opts.maxPerClaim,
    }).kept as HeldoutEvidence[];
  };
}

/**
 * 组装 verifyClaims 需要的 deps。search 缺省时返回 null ——
 * 这正是 verify.ts 里「本轮没有做外部核验」的那条诚实分支。
 */
export function makeHeldoutDeps(opts: {
  search?: HeldoutSearch | null;
  judge: VerifyDeps["judge"];
  citedOwners?: readonly string[];
  maxResults?: number;
  maxPerClaim?: number;
}): VerifyDeps | null {
  if (!opts.search) return null;
  return {
    findEvidence: makeHeldoutRetriever({
      search: opts.search,
      citedOwners: opts.citedOwners,
      maxResults: opts.maxResults,
      maxPerClaim: opts.maxPerClaim,
    }),
    judge: opts.judge,
  };
}