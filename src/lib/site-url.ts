/**
 * 站点根地址（不含路径）。robots / sitemap / layout 都从这里取，
 * 免得三处各写一份默认值、上线后互相不一致。
 *
 * 为什么不读请求头：备案后站点只在一个域名上对外，读 Host 等于允许任何人
 * 用伪造的 Host 让 sitemap 里写满陌生域名。所以只认部署方配置的 PROBE_SITE_URL，
 * 没配时回落到本地开发地址（正式部署必须配，见 .env.example）。
 */
const FALLBACK = "http://localhost:3210";

export function siteUrl(): string {
  const raw = (process.env.PROBE_SITE_URL ?? "").trim();
  if (!raw) return FALLBACK;
  try {
    return new URL(raw).origin;
  } catch {
    return FALLBACK;
  }
}

/** 站内路径 → 绝对地址（带 basePath 前缀，见 src/lib/base-path.ts）。 */
export function absoluteUrl(pathname: string, basePath: string): string {
  const prefix = basePath || "";
  const p = pathname.startsWith("/") ? pathname : "/" + pathname;
  return siteUrl() + prefix + p;
}
