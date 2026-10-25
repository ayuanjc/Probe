import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { extractJson, rejectsJsonSchema, schemaSkeleton, skeletonHint } from "@/lib/llm";

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

/**
 * 这个判定错了不会报错，只会让整条结构化链路静默降级：面板空着，日志里一行 failed。
 * 所以拿真实上游的报文把它钉住 —— 尤其是那些不写 invalid / unsupported 的。
 */
test("rejectsJsonSchema：认得出上游拒绝 response_format 的各种说法", () => {
  const rejected = [
    "400 Invalid request: response_format type json_schema is not supported",
    "Error code: 400 - {'error': {'message': 'response_format is invalid'}}",
    "Error code: 422 - structured output is not allowed for this model",
    "response_format json_schema unsupported",
    // DeepSeek 一类网关只回参数名 + 状态码，一个动词都不给
    "Error code: 400 - {'error': {'message': 'response_format: unknown field'}}",
    "400 response_format does not match the expected schema parameter",
    // DeepSeek 2026 的原话：一个 invalid / unsupported 都没有，只有 unavailable
    "This response_format type is unavailable now",
    "response_format 暂不可用",
  ];
  for (const m of rejected) assert.equal(rejectsJsonSchema(new Error(m)), true, m);
});

/**
 * 真实上游的 message 是原话，状态码在 APICallError.statusCode 字段里 —— message 里压根没有 "400"。
 * 只按文本判断会漏掉这种情况（面板全空、日志一行 failed），所以状态码必须单独认。
 * 但反过来也不能见 400 就当格式问题：模型名写错也是 400。
 */
test("rejectsJsonSchema：状态码在字段里、message 里没有数字时也认得出", () => {
  const withStatus = Object.assign(new Error("response_format: 参数不被支持的类型"), { statusCode: 400 });
  assert.equal(rejectsJsonSchema(withStatus), true);

  const fromBody = Object.assign(new Error("invalid request"), {
    statusCode: 422,
    responseBody: '{"error":{"message":"response_format is not supported"}}',
  });
  assert.equal(rejectsJsonSchema(fromBody), true);

  // 中文否定词
  assert.equal(rejectsJsonSchema(new Error("response_format 字段不被接受")), true);

  // 只说模型不可用、没提 response_format：与格式无关，别据此改走文本模式
  assert.equal(rejectsJsonSchema(new Error("The model is unavailable now")), false);

  // 只有参数名、没状态码、也没有可识别的否定词：不猜，交给重试逻辑
  assert.equal(rejectsJsonSchema(new Error("response_format: bad type")), false);

  // 400 且参数名出现，但 responseBody 说明是模型名错：不是格式问题
  const wrongModel = Object.assign(new Error("model not found"), { statusCode: 400 });
  assert.equal(rejectsJsonSchema(wrongModel), false);

  // 5xx 是上游故障
  const serverError = Object.assign(new Error("response_format upstream failure"), { statusCode: 500 });
  assert.equal(rejectsJsonSchema(serverError), false);
});

test("rejectsJsonSchema：网络抖动 / 限流 / key 失效不算格式问题", () => {
  const other = [
    "socket hang up",
    "Error code: 429 rate limit exceeded",
    "Error code: 401 invalid api key",
    "model not found",
    "fetch failed",
  ];
  for (const m of other) assert.equal(rejectsJsonSchema(new Error(m)), false, m);
});

test("extractJson：抠不出合法 JSON 时返回 undefined，不抛错", () => {
  assert.equal(extractJson(""), undefined);
  assert.equal(extractJson("模型今天不想干活"), undefined);
  assert.equal(extractJson("{不是合法 JSON}"), undefined);
  assert.equal(extractJson("{"), undefined);
});
/**
 * 纯文本兜底能跑通的前提是「键名照抄」。没有这段骨架，模型会把 attr/value 猜成 claim，
 * zod 复核必然失败，而失败是静默的（界面只说「没有可核验断言」）。
 */
test("schemaSkeleton：对象、数组、枚举、可选、数字都折成可照抄的骨架", () => {
  const ClaimLike = z.object({
    claims: z.array(
      z.object({
        attr: z.string(),
        value: z.string(),
        unit: z.string().optional(),
        sourceIds: z.array(z.string()),
        kind: z.enum(["quantitative", "causal", "opinion"]),
        score: z.number(),
      }),
    ),
  });
  const sk = schemaSkeleton(ClaimLike) as Record<string, any>;
  const one = sk.claims[0];
  assert.deepEqual(Object.keys(one).sort(), ["attr", "kind", "score", "sourceIds", "unit", "value"]);
  assert.equal(one.attr, "文本");
  assert.equal(one.unit, "文本（可省略）");
  assert.equal(one.kind, "quantitative|causal|opinion");
  assert.deepEqual(one.sourceIds, ["文本"]);
  assert.equal(one.score, 0);
});

test("skeletonHint：把骨架写进提示词，并明说不要改名", () => {
  const hint = skeletonHint(z.object({ verdict: z.enum(["support", "neutral"]), reason: z.string() }));
  assert.ok(hint.includes("字段名与嵌套结构必须与下面这份骨架完全一致"));
  assert.ok(hint.includes("\"support|neutral\""));
  assert.ok(hint.includes("\"reason\": \"文本\""));
});
