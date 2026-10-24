
/**
 * 请求头名放这里，是因为它要被两端共用：服务端（runtime-config）读它，
 * 浏览器端（settings）写它。runtime-config 依赖 node:async_hooks，
 * 客户端组件一旦 import 它就会把 node 内置模块拖进前端 bundle —— 所以常量要单独一个文件。
 */
export const CONFIG_HEADERS = {
  openaiKey: "x-probe-openai-key",
  openaiBaseUrl: "x-probe-openai-base-url",
  model: "x-probe-model",
  tavilyKey: "x-probe-tavily-key",
} as const;