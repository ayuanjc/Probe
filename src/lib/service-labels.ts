/**
 * 服务商 host / 检索源 id → 人话名称。
 *
 * 设置面板与首页的属地说明都用这一份：同一个地址在两处显示成
 * "api.deepseek.com" 和 "DeepSeek"，比显示错更难解释。
 * 纯函数、无 Node API —— 客户端组件要 import 它。
 */

/** host 后缀 → 服务商名。按后缀匹配，所以带不带端口、有没有子域都能命中。 */
const MODEL_HOSTS: ReadonlyArray<readonly [string, string]> = [
  ["api.openai.com", "OpenAI"],
  ["api.deepseek.com", "DeepSeek"],
  ["api.moonshot.cn", "Kimi（月之暗面）"],
  ["open.bigmodel.cn", "智谱 GLM"],
  ["dashscope.aliyuncs.com", "阿里百炼（Qwen）"],
  ["api.siliconflow.cn", "硅基流动"],
  ["openrouter.ai", "OpenRouter"],
  ["ark.cn-beijing.volces.com", "火山方舟"],
  ["qianfan.baidubce.com", "百度千帆"],
  ["api.minimax.chat", "MiniMax"],
  ["api.baichuan-ai.com", "百川智能"],
  ["api.stepfun.com", "阶跃星辰"],
  ["api.lingyiwanwu.com", "零一万物"],
  ["api.hunyuan.cloud.tencent.com", "腾讯混元"],
  ["spark-api-open.xf-yun.com", "讯飞星火"],
  ["api.deepinfra.com", "DeepInfra"],
  ["api.groq.com", "Groq"],
  ["api.together.xyz", "Together"],
];

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1", "host.docker.internal"]);

/** 模型端点 → 服务商名。认不出来就原样返回 host（编一个名字比显示域名更糟）。 */
export function modelVendor(host: string | null | undefined): string {
  const h = String(host ?? "").trim().toLowerCase();
  if (!h) return "未配置";
  if (LOCAL_HOSTS.has(h) || /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h)) {
    return "本机 / 内网模型";
  }
  for (const [suffix, name] of MODEL_HOSTS) {
    if (h === suffix || h.endsWith("." + suffix)) return name;
  }
  return h;
}

/** 检索源 id → 名称。fixture 是本地样本，不是服务商，单列。 */
const RETRIEVAL_NAMES: Record<string, string> = {
  bocha: "博查",
  tavily: "Tavily",
  gdelt: "GDELT",
  wiki: "Wikipedia",
  hn: "Hacker News",
  fixture: "本地演示样本",
};

export function retrievalLabel(id: string): string {
  return RETRIEVAL_NAMES[id] ?? id;
}

/** 「A、B 与 C」—— 中文列举，两个用"与"，三个以上用顿号收尾"与"。 */
export function joinZh(items: readonly string[]): string {
  const list = items.filter(Boolean);
  if (list.length === 0) return "无";
  if (list.length === 1) return list[0];
  if (list.length === 2) return list[0] + " 与 " + list[1];
  return list.slice(0, -1).join("、") + " 与 " + list[list.length - 1];
}
