/**
 * 预设表的形状钉住 —— 这张表是照各家文档手抄的，唯一能自动检查的是「结构别烂」与
 * 「老名字别回来」。真值对不对得靠人去看文档，但至少改坏时测试会先叫。
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_MODEL_ID,
  PRESET_MODELS,
  PROVIDERS,
  isPresetModel,
  presetById,
} from "@/lib/model-presets";

/** 已经确认不被上游接受的旧名（deepseek-chat 已不在 DeepSeek 文档的枚举里）。 */
const LEGACY = [
  "gpt-4.1-mini",
  "gpt-4o",
  "gpt-4o-mini",
  "deepseek-chat",
  "deepseek-reasoner",
  "kimi-latest",
  "kimi-k2-0905-preview",
  "glm-4.6",
  "qwen-plus",
  "qwen-max",
  "qwen2.5:7b",
];

test("八个预设，id 与名字都不重复", () => {
  assert.equal(PROVIDERS.length, 8);
  assert.equal(new Set(PROVIDERS.map((p) => p.id)).size, 8);
  assert.equal(new Set(PROVIDERS.map((p) => p.name)).size, 8);
});

test("baseUrl 要么留空（官方），要么是 https；唯一例外是本机 Ollama", () => {
  for (const p of PROVIDERS) {
    if (p.baseUrl === "") continue;
    if (p.id === "ollama") {
      assert.equal(p.baseUrl, "http://127.0.0.1:11434/v1");
      continue;
    }
    assert.match(p.baseUrl, /^https:\/\//, p.id + " 的接口地址应当是 https");
    assert.ok(!p.baseUrl.endsWith("/"), p.id + " 的接口地址别留尾斜杠");
  }
});

test("模型名干净：非空、无空白、无尾斜杠", () => {
  for (const p of PROVIDERS) {
    assert.ok(p.model.length > 0, p.id + " 缺模型名");
    assert.ok(!/\s/.test(p.model), p.id + " 的模型名带空白：" + p.model);
    assert.ok(!p.model.endsWith("/"), p.id + " 的模型名带尾斜杠");
  }
});

test("老名字不许回到预设表里", () => {
  const hit = PROVIDERS.filter((p) => LEGACY.includes(p.model));
  assert.deepEqual(hit.map((p) => p.id), [], "这些预设还在用上游已不认的名字");
});

test("默认模型必须是某个预设在用的那个 —— 否则面板推荐的名字点不到", () => {
  assert.ok(isPresetModel(DEFAULT_MODEL_ID), "DEFAULT_MODEL_ID 不在预设表里：" + DEFAULT_MODEL_ID);
  assert.equal(PRESET_MODELS.length, 8);
});

test("presetById 命中与未命中", () => {
  assert.equal(presetById("deepseek")?.model, "deepseek-flash");
  assert.equal(presetById("nope"), null);
});

test("每家都得有去拿 key 的地址", () => {
  for (const p of PROVIDERS) {
    assert.match(p.keyUrl, /^https:\/\//, p.id + " 的 keyUrl 应当是 https 链接");
    assert.ok(p.note.length > 0, p.id + " 缺一句说明");
  }
});
