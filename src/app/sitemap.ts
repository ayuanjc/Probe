import type { MetadataRoute } from "next";
import { BASE_PATH } from "@/lib/base-path";
import { absoluteUrl } from "@/lib/site-url";

/**
 * 只列**陌生人无登录就能看到**的页面。
 *
 * 不列 /（未登录会 307 到 /login）、/verify（要登录）、/account、/metrics、/ayuanjc：
 * sitemap 里放一堆重定向或登录墙，爬虫抓到的全是同一个登录页，权重反而被摊薄。
 * 首页仍然是入口，只是它由 /login 的 canonical 承担。
 */
export const dynamic = "force-dynamic";

export default function sitemap(): MetadataRoute.Sitemap {
  const prefix = BASE_PATH || "";
  const now = new Date();
  const page = (pathname: string, changeFrequency: "daily" | "monthly" | "yearly", priority: number) => ({
    url: absoluteUrl(pathname, prefix),
    lastModified: now,
    changeFrequency,
    priority,
  });
  return [
    page("/login", "monthly", 1),
    page("/signup", "monthly", 0.8),
    page("/privacy", "yearly", 0.4),
    page("/terms", "yearly", 0.4),
    page("/terms/en", "yearly", 0.3),
  ];
}
