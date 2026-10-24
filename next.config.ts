import type { NextConfig } from "next";

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

const nextConfig: NextConfig = {
  reactStrictMode: true,
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
