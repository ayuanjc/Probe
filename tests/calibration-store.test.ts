import assert from "node:assert/strict";
import { test } from "node:test";
import {
  appendSample,
  applyLabel,
  countSamples,
  labelSample,
  parseSamples,
  pairsOf,
  readSamples,
  recordSample,
  snapshotOf,
  type CalibrationSample,
} from "@/lib/calibration-store";

function sample(
  id: string,
  predicted: number,
  correct: boolean | null = null,
  by: string | null = "u1",
): CalibrationSample {
  return {
    id,
    at: 1_000,
    predicted,
    judged: 4,
    nEff: 3,
    contradicted: 0,
    claims: 5,
    by,
    correct,
    labeledAt: correct === null ? null : 2_000,
  };
}

function mem(init: string | null = null) {
  let value = init;
  return {
    async read() {
      return value;
    },
    async write(text: string) {
      value = text;
    },
    raw() {
      return value;
    },
  };
}

test("appendSample：同 id 覆盖，超上限丢最老的", () => {
  const first = appendSample([], sample("a", 0.8));
  const dup = appendSample(first, sample("a", 0.6));
  assert.equal(dup.length, 1);
  assert.equal(dup[0].predicted, 0.6);

  const three = appendSample(appendSample(appendSample([], sample("a", 0.1)), sample("b", 0.2)), sample("c", 0.3));
  const four = appendSample(three, sample("d", 0.4), 3);
  assert.deepEqual(four.map((s) => s.id), ["b", "c", "d"]);
});

test("applyLabel：命中就改，未命中不改且返回新数组", () => {
  // sample() 默认 by="u1"：这里以本人身份标，才走得到「命中就改」那条路。
  const list = [sample("a", 0.8), sample("b", 0.6)];
  const hit = applyLabel(list, "b", true, 9_000, { id: "u1", admin: false });
  assert.equal(hit.ok, true);
  assert.equal(hit.list[1].correct, true);
  assert.equal(hit.list[1].labeledAt, 9_000);
  assert.equal(hit.list[0].correct, null);

  const miss = applyLabel(list, "zzz", true, 9_000, { id: "u1", admin: false });
  assert.equal(miss.ok, false);
  assert.notEqual(miss.list, list);
  assert.deepEqual(miss.list.map((s) => s.correct), [null, null]);
});

test("pairsOf：未标注与非法预测都不进对子", () => {
  const pairs = pairsOf([
    sample("a", 0.8, true),
    sample("b", 0.4, false),
    sample("c", 0.9, null),
    sample("d", Number.NaN, true),
  ]);
  assert.deepEqual(pairs, [
    { predicted: 0.8, correct: true },
    { predicted: 0.4, correct: false },
  ]);
});

test("countSamples：空库与混合样本", () => {
  assert.deepEqual(countSamples([]), { total: 0, labeled: 0, unlabeled: 0, latestAt: null });
  const counts = countSamples([
    { ...sample("a", 0.8, true), at: 100 },
    { ...sample("b", 0.5, null), at: 300 },
  ]);
  assert.deepEqual(counts, { total: 2, labeled: 1, unlabeled: 1, latestAt: 300 });
});

test("snapshotOf：没有标注就 null，20 条标注仍判 unknown", () => {
  const empty = snapshotOf([]);
  assert.equal(empty.report, null);
  assert.equal(empty.verdict, "unknown");
  assert.equal(empty.counts.total, 0);

  const ten = Array.from({ length: 10 }, (_, i) => sample("ok" + i, 0.9, true));
  const tenBad = Array.from({ length: 10 }, (_, i) => sample("bad" + i, 0.3, false));
  const snap = snapshotOf([...ten, ...tenBad]);
  assert.ok(snap.report);
  assert.equal(snap.report.n, 20);
  assert.equal(snap.report.ece.toFixed(4), "0.2000");
  // 样本量不足 50：宁可说不知道，也不给一个由 20 条算出来的「校准良好」。
  assert.equal(snap.verdict, "unknown");
  assert.equal(snap.recent.length, 10);
});

test("parseSamples：坏文件当空库，脏条目逐条丢", () => {
  assert.deepEqual(parseSamples(null), []);
  assert.deepEqual(parseSamples("{not json"), []);
  assert.deepEqual(parseSamples("123"), []);

  const raw = JSON.stringify({
    samples: [
      { id: "a", predicted: 1.4, at: 5 },
      { id: "b", predicted: "0.5" },
      { predicted: 0.5 },
      { id: "c", predicted: 0.5, correct: "yes", judged: "x" },
    ],
  });
  const list = parseSamples(raw);
  assert.deepEqual(list.map((s) => s.id), ["a", "c"]);
  assert.equal(list[0].predicted, 1);
  assert.equal(list[1].correct, null);
  assert.equal(list[1].judged, 0);
});

test("recordSample / labelSample：走存储往返", async () => {
  const store = mem();
  const s = await recordSample(
    { by: "u1", predicted: 0.73, judged: 4, nEff: 3.1, contradicted: 1, claims: 6 },
    store,
  );
  assert.match(s.id, /^cal_/);
  assert.equal(s.correct, null);

  const read = await readSamples(store);
  assert.equal(read.length, 1);
  assert.equal(read[0].predicted, 0.73);

  const miss = await labelSample("cal_nope", true, { id: "u1", admin: false }, store);
  assert.equal(miss.ok, false);
  assert.equal(miss.denied, false);
  assert.equal((await readSamples(store))[0].correct, null);

  const hit = await labelSample(s.id, true, { id: "u1", admin: false }, store);
  assert.equal(hit.ok, true);
  assert.equal(hit.sample?.correct, true);
  const after = await readSamples(store);
  assert.equal(after[0].correct, true);
  assert.ok(JSON.parse(store.raw() as string));
});
test("applyLabel：别人的样本标不了，管理员可以；历史样本只认管理员", () => {
  const list = [sample("mine", 0.8, null, "u1"), sample("other", 0.7, null, "u2"), sample("legacy", 0.6, null, null)];

  // 不是自己的：拒绝，且不写任何东西
  const denied = applyLabel(list, "other", true, 9_000, { id: "u1", admin: false });
  assert.equal(denied.ok, false);
  assert.equal(denied.denied, true);
  assert.equal(denied.list.find((s) => s.id === "other")?.correct, null);

  // 自己的：放行
  const mine = applyLabel(list, "mine", true, 9_000, { id: "u1", admin: false });
  assert.equal(mine.ok, true);

  // 管理员：谁都能标
  const asAdmin = applyLabel(list, "other", false, 9_000, { id: "root", admin: true });
  assert.equal(asAdmin.ok, true);

  // 历史样本（by=null）证明不了归属，普通用户标不了、管理员可以
  const legacyByUser = applyLabel(list, "legacy", true, 9_000, { id: "u1", admin: false });
  assert.equal(legacyByUser.denied, true);
  const legacyByAdmin = applyLabel(list, "legacy", true, 9_000, { id: "root", admin: true });
  assert.equal(legacyByAdmin.ok, true);
});

test("recordSample：写明 by，未登录落 null", async () => {
  const store = mem();
  const owned = await recordSample({ by: "u9", predicted: 0.5, judged: 2, nEff: 1, contradicted: 0, claims: 3 }, store);
  assert.equal(owned.by, "u9");
  const anon = await recordSample({ predicted: 0.4, judged: 1, nEff: 1, contradicted: 0, claims: 2 }, store);
  assert.equal(anon.by, null);
  const list = await readSamples(store);
  assert.deepEqual(list.map((s) => s.by), ["u9", null]);
});
