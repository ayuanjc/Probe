import type { MetadataRoute } from "next";
import { ADMIN_PATH } from "@/lib/admin-path";
import { BASE_PATH } from "@/lib/base-path";
import { siteUrl } from "@/lib/site-url";

/**
 * robots.txt 由代码生成，而不是 public/ 里的静态文件 —— 这样 sitemap 的地址
 * 永远跟着部署配置走，改域名不会忘掉一处。
 *
 * 这份规则的口径：
 *   - 允许抓公开页（/、/login、/signup、/privacy、/terms），这些是陌生人能看到的全部；
 *   - 拒绝 /api（全是 JSON，抓了只会浪费配额）、/ayuanjc（后台）、/account、/metrics
 *     （两个都要登录，抓到的永远是登录墙）；
 *   - 明确写 sitemap —— 不写就要等爬虫自己猜。
 */
export const dynamic = "force-dynamic";

export default function robots(): MetadataRoute.Robots {
  const prefix = BASE_PATH || "";
  return {
    rules: [
      {
        userAgent: "*",
        allow: prefix + "/",
        disallow: [
          prefix + "/api/",
          // 后台路径只认 ADMIN_PATH：改路径时不能靠人记得来这里也改一次。
          prefix + ADMIN_PATH,
          prefix + "/account",
          prefix + "/metrics",
          prefix + "/verify",
        ],
      },
    ],
    sitemap: siteUrl() + prefix + "/sitemap.xml",
    host: siteUrl(),
  };
}
