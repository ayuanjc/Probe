import type { MetadataRoute } from "next";
import { BASE_PATH } from "@/lib/base-path";

/**
 * 主屏图标与独立窗口的声明。挂在子路径（预览站是 /probe）时，start_url / scope / icons
 * 都必须自己带上前缀 —— 它们在文件里是字符串，不会被路由层改写。
 */
export const dynamic = "force-static";

export default function manifest(): MetadataRoute.Manifest {
  const base = BASE_PATH;

  return {
    name: "探针 · Probe",
    short_name: "探针",
    description: "见微，知著：每个数字都能点回原文。",
    lang: "zh-CN",
    start_url: base + "/",
    scope: base + "/",
    display: "standalone",
    orientation: "portrait-primary",
    background_color: "#000000",
    theme_color: "#000000",
    icons: [
      { src: base + "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
      { src: base + "/apple-icon.png", sizes: "180x180", type: "image/png", purpose: "any" },
    ],
  };
}
