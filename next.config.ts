import type { NextConfig } from "next";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * 版本号只有一个来源：package.json。
 * 构建时读出来写成 NEXT_PUBLIC_PROBE_VERSION，客户端与服务端都从
 * src/lib/version.ts 拿同一份 —— 页脚显示、/api/version 返回、README 的
 * 发版说明因此不会各写一个数字。
 */
const pkg = JSON.parse(
  readFileSync(fileURLToPath(new URL("./package.json", import.meta.url)), "utf8"),
) as { version?: string };
const version = pkg.version ?? "0.0.0";

/**
 * 预览站挂在服务器现有的 80 端口 nginx 下面（location /probe/），
 * 所以构建时给一个 basePath；不设就照常在根路径跑（dev / 自托管首页）。
 *
 * 注意：Next 的 basePath 只改写路由与 /_next 静态资源，客户端手写的
 * fetch("/api/…") 不会被改写 —— 那些地方统一走 src/lib/base-path.ts 的 appPath()。
 */
const basePath = (process.env.PROBE_BASE_PATH ?? "").replace(/\/+$/, "");

/**
 * 构建目录也做成可换的：服务器上的自动更新先把新版本构建进 .next-staging，
 * 成功了才把目录换过去再重启。直接在 .next 上原地构建，一次失败的构建会把
 * 正在服务的产物弄成半截（页面白屏、chunk 404），预览站就整站挂了。
 */
const distDir = process.env.PROBE_DIST_DIR || ".next";

/**
 * 安全响应头。
 *
 * 之前一个都没有：没有 CSP、没有 nosniff、没有 frame-ancestors，还带着
 * `X-Powered-By: Next.js`。对一个"抓外部网页 + 把用户提交的文本一路显示出来"
 * 的站点来说，这些是最后一道墙 —— 一旦哪天某个渲染路径漏了转义，
 * 有 CSP 也只是执行失败，没有 CSP 就是直接执行。
 *
 * CSP 说明（为什么带 'unsafe-inline'）：Next 的 RSC 载荷是以内联 <script>
 * 下发的，Tailwind 与图表组件也用内联 style。用 nonce 方案要改整个渲染链，
 * 收益（挡住内联注入）与成本不成比例；'unsafe-inline' + 没有 'unsafe-eval'
 * 仍然挡住了「加载外部脚本」和「eval 字符串」这两条最常见的升级路径。
 */
function securityHeaders(): { key: string; value: string }[] {
  const dev = process.env.NODE_ENV !== "production";
  const csp = [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    `script-src 'self' 'unsafe-inline'${dev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    // 前端所有请求都是同源（见 src/lib/base-path.ts 的 appPath），外部 API 全在服务端调。
    "connect-src 'self'",
    "worker-src 'self' blob:",
    "manifest-src 'self'",
  ].join("; ");

  const list = [
    { key: "Content-Security-Policy", value: csp },
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "X-Frame-Options", value: "DENY" },
    { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    {
      key: "Permissions-Policy",
      value: "camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), midi=(), display-capture=()",
    },
    { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
    { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
    { key: "X-Permitted-Cross-Domain-Policies", value: "none" },
  ];

  // HSTS 只在真的走 HTTPS 时开：nginx 目前是 :80 明文，发了也没用，
  // 而一旦以后有人在同域上跑了别的 HTTP 服务，提前发 HSTS 会把那些站锁死。
  if (process.env.PROBE_ENABLE_HSTS === "1") {
    list.push({ key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" });
  }
  return list;
}

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // 别在响应里自报框架版本：省掉一条免费的指纹线索。
  poweredByHeader: false,
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders() }];
  },
  env: { NEXT_PUBLIC_PROBE_VERSION: version },
  ...(basePath ? { basePath } : {}),
  ...(distDir !== ".next" ? { distDir } : {}),
  // 用 127.0.0.1 访问 dev server 时，Next 会拦掉 /_next/* 的跨源请求，
  // 结果 HMR client 与 dev chunk 拿不到、页面停在 SSR 骨架不 hydrate。
  allowedDevOrigins: ["127.0.0.1", "localhost"],
  experimental: {
    // Streaming responses are the whole point of this product.
    proxyTimeout: 120_000,
  },
};

export default nextConfig;
