import { createHash } from "node:crypto";
import { fetchArticle, splitSegments } from "./translate";

/**
 * 取文与切段。只做两件事，不含任何判断。
 *
 * 上限与 translate 那两个常数不是一回事：那边服务的是「翻译一段引文」，6000 字够；
 * 这边服务的是「核一篇文章」，40000 字才够看全文。所以这里自己写死上限，
 * 不去改 translate 的 DOC_MAX_CHARS —— 那会让翻译页的截断行为跟着变。
 */

export const VERIFY_MAX_CHARS = 40_000;
export const VERIFY_MAX_SEGMENTS = 24;

export type DocSegment = { idx: number; charStart: number; charEnd: number; text: string };

export type VerifyDoc = {
  docId: string;
  title: string;
  text: string;
  chars: number;
  sourceUrl: string | null;
  /** 原文被上限截断过（不是分段截断）。 */
  truncated: boolean;
};

export type DocLoadFail = {
  ok: false;
  code: "verify:fetch_failed" | "verify:not_html" | "verify:too_short" | "verify:empty" | "verify:url_blocked";
  detail?: string;
};

export type DocLoad = { ok: true; doc: VerifyDoc; segments: DocSegment[]; degraded: string[] } | DocLoadFail;

/** docId 只依赖正文，所以同一篇文章重跑命中同一个缓存文件、同一个 claimId 前缀。 */
export function docIdOf(text: string): string {
  return createHash("sha1").update(normalizeForId(text)).digest("hex").slice(0, 16);
}

function normalizeForId(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t\u00a0]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * 据原文回填每段的绝对偏移，并保证每段 text 是**原文的逐字切片**。
 *
 * 不信任任何外部给的坐标：splitSegments 只回字符串，偏移在这里顺序推出来。
 * 走三步（逐字 → 空白等价 → 游标兜底），第三步会记进 failed，由调用方写进 degraded。
 */
function locate(text: string, chunks: readonly string[]): { segments: DocSegment[]; failed: number[] } {
  const out: DocSegment[] = [];
  const failed: number[] = [];
  let cursor = 0;

  chunks.forEach((chunk, idx) => {
    // 1) 先试逐字命中：大多数段落（未跨段合并的）一次命中。
    const exact = text.indexOf(chunk, cursor);
    if (exact >= 0) {
      out.push({ idx, charStart: exact, charEnd: exact + chunk.length, text: chunk });
      cursor = exact + chunk.length;
      return;
    }

    /**
     * 2) 空白等价对齐。splitSegments 把合并的短段用单个空格连起来，而原文那里是
     *    "\n\n" —— 于是 indexOf 必然失败。差别只在空白，所以按「空白对空白」走一遍，
     *    但**返回的 text 一律取原文切片**：段落文本必须能在原文里 indexOf 到，
     *    否则 S2 的 quote 复核（indexOf 命中）会全军覆没，而那不是模型的错。
     */
    const span = alignIgnoringWhitespace(text, chunk, cursor);
    if (span) {
      out.push({ idx, charStart: span.start, charEnd: span.end, text: text.slice(span.start, span.end) });
      cursor = span.end;
      return;
    }

    // 3) 兜底：从游标起按长度切。宁可偏移不准，也不要整段丢空导致后面的段全错位。
    failed.push(idx);
    const end = Math.min(text.length, cursor + chunk.length);
    out.push({ idx, charStart: cursor, charEnd: end, text: text.slice(cursor, end) });
    cursor = end;
  });

  return { segments: out, failed };
}

const WS = /\s/;

/**
 * 在 text 里从 from 起找 chunk，把任意空白串视作等价（chunk 的一个空白 ≈ text 的一段空白）。
 * 返回原文上的 [start, end)；对不上返回 null。逐字符走，文本上限 4 万字，不做索引优化。
 */
function alignIgnoringWhitespace(text: string, chunk: string, from: number): { start: number; end: number } | null {
  let i = from;
  while (i < text.length && WS.test(text[i])) i++;
  const start = i;
  let j = 0;
  while (j < chunk.length) {
    if (i >= text.length) return null;
    const c = chunk[j];
    if (WS.test(c)) {
      while (j < chunk.length && WS.test(chunk[j])) j++;
      if (i >= text.length || !WS.test(text[i])) return null;
      while (i < text.length && WS.test(text[i])) i++;
    } else {
      if (text[i] !== c) return null;
      i++;
      j++;
    }
  }
  return { start, end: i };
}

export async function loadDoc(input: { text?: string; url?: string }): Promise<DocLoad> {
  const degraded: string[] = [];
  const provided = (input.text ?? "").trim();
  const url = (input.url ?? "").trim();

  let body = provided;
  let title = "";
  let sourceUrl: string | null = null;
  let truncated = false;

  if (body.length === 0 && url) {
    const got = await fetchArticle(url);
    if (!got.ok) {
      const code = got.reason === "url_blocked" ? "verify:url_blocked"
        : got.reason === "not_html" ? "verify:not_html"
        : "verify:fetch_failed";
      return { ok: false, code, detail: got.reason };
    }
    body = got.text;
    title = got.title;
    sourceUrl = url;
    truncated = Boolean(got.truncated);
  }

  if (body.length === 0) return { ok: false, code: "verify:empty" };
  // 120 字以下不是文章，是碎片。与 fetchArticle 里那条判据同一口径。
  if (body.length < 120) return { ok: false, code: "verify:too_short", detail: String(body.length) };

  if (body.length > VERIFY_MAX_CHARS) {
    body = body.slice(0, VERIFY_MAX_CHARS);
    truncated = true;
    degraded.push("verify:truncated");
  }

  const split = splitSegments(body, VERIFY_MAX_SEGMENTS);
  if (split.truncated) degraded.push("segments:capped");
  const aligned = locate(body, split.segments);
  const segments = aligned.segments;
  // 对齐失败要说出来：偏移错位会让高亮错行，比不给高亮更糟。
  if (aligned.failed.length > 0) degraded.push("verify:align_failed");

  return {
    ok: true,
    doc: { docId: docIdOf(body), title, text: body, chars: body.length, sourceUrl, truncated },
    segments,
    degraded,
  };
}
