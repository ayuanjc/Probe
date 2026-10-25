/**
 * 各家模型的名字与接口地址 —— 全站唯一一份。
 *
 * 为什么单独一个文件：这两个常量原来分散在 ApiKeyHelp.tsx（DEFAULT_MODEL）与
 * runtime-config.ts（DEFAULT_MODEL_ID），互相靠一行「必须和 xx 一致」的注释约束。
 * 注释拦不住漂移：改一处忘另一处，面板 placeholder 会推荐一个服务端根本不回落的模型。
 * 现在两边 import 同一个值，并且 tests/model-presets.test.ts 把形状钉住。
 *
 * 抄写日期：2026-10-25。这份表会过时，过时了就把 id 换成当天的旗舰/廉价档；
 * 别指望它自己跟上（各家改名比发版还勤：OpenAI 的 mini/nano 已经换成 luna/terra/sol，
 * DeepSeek 的 deepseek-chat 已经不接受）。
 *
 * 这里不是白名单 —— 模型名本来就能手填，填错了上游返回 400，面板里有提示。
 */

export type ProviderPreset = {
  id: string;
  name: string;
  /** 空串 = 官方地址（SDK 默认 https://api.openai.com/v1）。 */
  baseUrl: string;
  model: string;
  /** 去哪拿 key。 */
  keyUrl: string;
  note: string;
};

export const PROVIDERS: ProviderPreset[] = [
  {
    id: "openai",
    name: "OpenAI 官方",
    baseUrl: "",
    model: "gpt-6-luna",
    keyUrl: "https://platform.openai.com/api-keys",
    note: "接口地址留空即官方",
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    model: "deepseek-flash",
    keyUrl: "https://platform.deepseek.com/api_keys",
    note: "便宜、中文稳，key 也是 sk- 开头",
  },
  {
    id: "moonshot",
    name: "Kimi（月之暗面）",
    baseUrl: "https://api.moonshot.cn/v1",
    model: "kimi-k3.1-pro",
    keyUrl: "https://platform.moonshot.cn/console/api-keys",
    note: "长上下文友好",
  },
  {
    id: "zhipu",
    name: "智谱 GLM",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    model: "glm-5.3",
    keyUrl: "https://bigmodel.cn/usercenter/apikeys",
    note: "有免费额度；路径是 /api/paas/v4",
  },
  {
    id: "dashscope",
    name: "阿里百炼（Qwen）",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    model: "qwen3.8-flash",
    keyUrl: "https://bailian.console.aliyun.com/",
    note: "必须走 compatible-mode 兼容路径",
  },
  {
    id: "siliconflow",
    name: "硅基流动",
    baseUrl: "https://api.siliconflow.cn/v1",
    model: "deepseek-ai/DeepSeek-V4-Flash",
    keyUrl: "https://cloud.siliconflow.cn/account/ak",
    note: "一个 key 转多家开源模型",
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    model: "openai/gpt-6-luna",
    keyUrl: "https://openrouter.ai/keys",
    note: "聚合一堆厂商，模型名带 厂商/ 前缀",
  },
  {
    id: "ollama",
    name: "本地 Ollama",
    baseUrl: "http://127.0.0.1:11434/v1",
    model: "qwen3.8:latest",
    keyUrl: "https://ollama.com/download",
    note: "不用注册，key 随便填 8 位（如 ollama-local）",
  },
];

/** 面板空着、env 也没配时用的模型。必须能在上面某个预设里点到，否则面板会推荐一个点不到的名字。 */
export const DEFAULT_MODEL_ID = "gpt-6-luna";

/** 预设里出现过的模型名（去重、保持顺序）—— 下拉候选的前半段就是它。 */
export const PRESET_MODELS: string[] = Array.from(new Set(PROVIDERS.map((p) => p.model)));

export function presetById(id: string): ProviderPreset | null {
  return PROVIDERS.find((p) => p.id === id) ?? null;
}

/** 默认模型是不是某个预设在用的那个（面板的下拉候选靠这条不变式才自洽）。 */
export function isPresetModel(model: string): boolean {
  return PRESET_MODELS.includes(model);
}
