import { AsyncLocalStorage } from "node:async_hooks";

/**
 * 「这一轮上游调用算在谁头上」。
 *
 * 为什么要这个东西：每日模型额度原来是**进程级全局**的一个计数器
 * （PROBE_DAILY_LLM_CALLS），意味着任何一个登录用户都能把所有人的额度烧光 ——
 * 烧完大家一起降级到本地模板。限流按 IP 也挡不住：换 IP、换个账号就行。
 *
 * 用 AsyncLocalStorage 而不是把 userId 一层层传下去：llm.ts 在调用链的最深处
 * （analyze → extractClaims → generateStructured），中间隔着六七层不需要知道
 * 用户是谁的函数。ALS 让「当前请求是谁」变成一个上下文事实，签名不用动。
 *
 * 注意 SSE：流式响应的 start() 可能在路由函数返回之后才执行，那里必须重新
 * runWithCallScope 一次，否则额度计数会算到「没有用户」的头上。
 */
export type CallScope = {
  /** 计数键。用户维度用 "u:<id>"，未登录维度用 "ip:<hash>"。 */
  key: string;
  /** 只用于日志，不落库。 */
  label: string;
};

const als = new AsyncLocalStorage<CallScope>();

export function runWithCallScope<T>(scope: CallScope, fn: () => T): T {
  return als.run(scope, fn);
}

export function currentCallScope(): CallScope | undefined {
  return als.getStore();
}

export function currentCallScopeKey(): string | undefined {
  return als.getStore()?.key;
}
