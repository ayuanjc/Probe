import assert from "node:assert/strict";
import { test } from "node:test";
import {
  HISTORY_KEY,
  HISTORY_MAX,
  clearHistory,
  mergeHistory,
  parseHistory,
  pushHistory,
  readHistory,
  type HistoryStore,
} from "../src/lib/history";

/** 内存版存储：Node 里没有 localStorage，注入这个比 mock 全局干净。 */
function memStore(initial: Record<string, string> = {}): HistoryStore & { data: Record<string, string> } {
  const data: Record<string, string> = { ...initial };
  return {
    data,
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => {
      data[k] = v;
    },
  };
}

test("mergeHistory：重复查询提到最前而不是留下两条", () => {
  const list = ["a", "b", "c"];
  assert.deepEqual(mergeHistory(list, "b"), ["b", "a", "c"]);
  assert.deepEqual(mergeHistory(list, "a"), ["a", "b", "c"]);
});

test("mergeHistory：新查询插到最前，空查询不改变列表", () => {
  assert.deepEqual(mergeHistory(["a"], "z"), ["z", "a"]);
  assert.deepEqual(mergeHistory(["a"], "   "), ["a"]);
  assert.deepEqual(mergeHistory(["a"], ""), ["a"]);
});

test("mergeHistory：超过上限就截断，且留下的是最近的", () => {
  const list = Array.from({ length: HISTORY_MAX }, (_, i) => "q" + i);
  const next = mergeHistory(list, "fresh");
  assert.equal(next.length, HISTORY_MAX);
  assert.equal(next[0], "fresh");
  assert.equal(next.includes("q" + (HISTORY_MAX - 1)), false);
});

test("parseHistory：脏数据一律当没有，不抛", () => {
  assert.deepEqual(parseHistory(null), []);
  assert.deepEqual(parseHistory("not json"), []);
  assert.deepEqual(parseHistory("{a:1}"), []);
  assert.deepEqual(parseHistory("[1,2,3]"), []);
  const dirty = "[" + JSON.stringify(" a ") + ", " + JSON.stringify("") + ", " + JSON.stringify("a") + ", 3]";
  assert.deepEqual(parseHistory(dirty), ["a"]);
});

test("pushHistory：写回存储并返回新列表；没有存储时只在内存里返回", () => {
  const store = memStore();
  const next = pushHistory("  探针怎么用  ", store);
  assert.deepEqual(next, ["探针怎么用"]);
  assert.deepEqual(readHistory(store), ["探针怎么用"]);
  pushHistory("第二问", store);
  assert.deepEqual(readHistory(store), ["第二问", "探针怎么用"]);
  assert.deepEqual(pushHistory("第三问", null), ["第三问"]);
});

test("clearHistory：清空后读出空数组", () => {
  const store = memStore();
  pushHistory("x", store);
  clearHistory(store);
  assert.deepEqual(readHistory(store), []);
  assert.equal(store.data[HISTORY_KEY], "[]");
});

test("存储抛异常（隐私模式 / 配额满）不影响返回", () => {
  const broken: HistoryStore = {
    getItem: () => {
      throw new Error("blocked");
    },
    setItem: () => {
      throw new Error("quota");
    },
  };
  assert.deepEqual(readHistory(broken), []);
  assert.deepEqual(pushHistory("still works", broken), ["still works"]);
  assert.doesNotThrow(() => clearHistory(broken));
});
