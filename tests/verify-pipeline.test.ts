import test from "node:test";
import assert from "node:assert/strict";

import { runVerify } from "@/agents/verify-pipeline";
import { VERIFY_EVENT_NAMES } from "@/lib/verify-events";
import type { VerifyEvent } from "@/lib/verify-events";
import { llmEnabled } from "@/lib/llm";

/**
 * 端到端事件序测试。
 *
 * 这里断言的是**接线**，不是核验质量：事件名合法、顺序符合 verify-events.ts 的契约、
 * 断网（没有模型 key）时也给用户一个诚实的 N/A 而不是 0 分。核验质量由 dossier /
 * grade / agreement 那几层各自的单测钉住。
 */

const LONG =
  "公司在 2025 年第三季度实现营业收入 32.4 亿元，同比增长 18.6%。" +
  "管理层在业绩说明会上表示，增长主要来自海外市场，并在报告期内新增两家区域子公司。" +
  "公司同时宣布，2026 年将继续扩大在东南亚的渠道投入，预计资本开支 6 亿元。";

async function collect(input: { text?: string; url?: string }): Promise<VerifyEvent[]> {
  const out: VerifyEvent[] = [];
  for await (const e of runVerify(input)) out.push(e);
  return out;
}

test("事件名全部在契约里，且 doc.parsed 第一、done 最后", async () => {
  const events = await collect({ text: LONG });
  const names = events.map((e) => e.event);
  for (const n of names) assert.ok((VERIFY_EVENT_NAMES as readonly string[]).includes(n), n);
  assert.equal(names[0], "doc.parsed");
  assert.equal(names[names.length - 1], "done");
  assert.equal(names.filter((n) => n === "doc.scored").length, 1);
  assert.equal(names.filter((n) => n === "done").length, 1);
});

test("doc.parsed 带分段，且分段区间拼回原文", async () => {
  const events = await collect({ text: LONG });
  const parsed = events[0];
  assert.equal(parsed.event, "doc.parsed");
  if (parsed.event !== "doc.parsed") return;
  assert.equal(parsed.data.chars, LONG.length);
  assert.ok(parsed.data.segments.length >= 1);
  const first = parsed.data.segments[0];
  assert.equal(first.charStart, 0);
  assert.equal(LONG.slice(first.charStart, first.charEnd), first.text);
});

test("没有模型 key 时给 N/A 与 claims:unavailable，绝不发 0/0.5 冒充分数", async () => {
  if (llmEnabled()) return;
  const events = await collect({ text: LONG });
  const done = events[events.length - 1];
  assert.equal(done.event, "done");
  if (done.event !== "done") return;
  assert.equal(done.data.scores.grade, "N/A");
  assert.equal(done.data.scores.agreement, null);
  assert.equal(done.data.scores.nEff, 0);
  assert.equal(done.data.scores.rows.length, 0);
  assert.ok(done.data.notes.includes("claims:unavailable"));
  assert.equal(done.data.stats.claims, 0);
});

test("正文太短 → error 事件（而不是 N/A 的 done）", async () => {
  const events = await collect({ text: "太短了。" });
  assert.equal(events.length, 1);
  assert.equal(events[0].event, "error");
});

test("既没正文也没链接 → error 事件", async () => {
  const events = await collect({});
  assert.equal(events.length, 1);
  assert.equal(events[0].event, "error");
});
