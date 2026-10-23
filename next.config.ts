import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // 用 127.0.0.1 访问 dev server 时，Next 会拦掉 /_next/* 的跨源请求，
  // 结果 HMR client 与 dev chunk 拿不到、页面停在 SSR 骨架不 hydrate。
  allowedDevOrigins: ["127.0.0.1", "localhost"],
  experimental: {
    // Streaming responses are the whole point of this product.
    proxyTimeout: 120_000,
  },
};

export default nextConfig;
