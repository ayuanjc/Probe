import test from "node:test";
import assert from "node:assert/strict";
import { extractJson } from "@/lib/llm";

/**
 * 换行与 Markdown 围栏用常量拼：这些测试要求模型输出里带 \n 与三个反引号，
 * 直接写字面量在生成/转义链上太容易被吞掉，拼出来反而稳。
 */
const NL = String.fromCharCode(10);
const TICK = String.fromCharCode(96, 96, 96);
const OBJ = JSON.stringify({ a: 1 });

test("extractJson：纯 JSON、代码围栏、前后废话都能抠出来", () => {
  assert.deepEqual(extractJson(OBJ), { a: 1 });
  assert.deepEqual(extractJson(TICK + "json" + NL + OBJ + NL + TICK), { a: 1 });
  assert.deepEqual(extractJson("好的，结果如下：" + NL + OBJ + NL + "希望有帮助"), { a: 1 });
  assert.deepEqual(extractJson("前缀 " + JSON.stringify([1, 2, 3]) + " 后缀"), [1, 2, 3]);
});

test("extractJson：抠不出合法 JSON 时返回 undefined，不抛错", () => {
  assert.equal(extractJson(""), undefined);
  assert.equal(extractJson("模型今天不想干活"), undefined);
  assert.equal(extractJson("{不是合法 JSON}"), undefined);
  assert.equal(extractJson("{"), undefined);
});
