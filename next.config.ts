import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  experimental: {
    // Streaming responses are the whole point of this product.
    proxyTimeout: 120_000,
  },
};

export default nextConfig;
