/**
 * 同一份代码要能挂在两种位置上：本机根路径（dev、自托管首页）与服务器上的 /probe 子路径。
 *
 * Next 的 basePath 会自动改写路由与 /_next 静态资源，但**不会**改写客户端手写的
 * fetch("/api/…")、new EventSource("/api/…") 这类字符串。挂在 /probe 下时这些请求
 * 会打到宿主机根，拿到的是别的站点的 404，表现成「点了没反应」。所以统一走 appPath()。
 *
 * 读 NEXT_PUBLIC_ 前缀的变量：只有这个前缀会被内联进浏览器 bundle，
 * 服务端的 PROBE_BASE_PATH（next.config.ts 用的那个）在客户端是读不到的。
 */
export const BASE_PATH = (process.env.NEXT_PUBLIC_PROBE_BASE_PATH ?? "").replace(/\/+$/, "");

/** 把站内绝对路径拼上部署前缀：appPath("/api/search") → "/probe/api/search"。 */
export function appPath(p: string): string {
  return BASE_PATH + p;
}

/**
 * 反过来：把已经带前缀的路径还原成路由路径。
 *
 * 两种路径要分清，混了会得到 /probe/probe/login：
 * - **裸请求 / 裸跳转**（fetch、EventSource、window.location）必须 appPath() —— 没人替你加。
 * - **Next 的路由**（<Link href>、router.push/replace、redirect()）自己会叠 basePath，必须写裸路径。
 * 从 ?next= 这类外部传进来的值，可能已经带了前缀，过一遍 stripBasePath 再交给路由。
 */
export function stripBasePath(p: string): string {
  if (BASE_PATH && (p === BASE_PATH || p.startsWith(BASE_PATH + "/"))) {
    return p.slice(BASE_PATH.length) || "/";
  }
  return p;
}