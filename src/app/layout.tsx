import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";
import SessionBar from "@/components/SessionBar";
import UpdateBanner from "@/components/UpdateBanner";
import SiteFooter from "@/components/SiteFooter";
import { BASE_PATH } from "@/lib/base-path";

/**
 * 分享卡上的绝对地址从哪来：NEXT_PUBLIC_ 前缀会在构建期被内联，这里要的是部署时再定，
 * 所以用不带前缀的服务端变量 PROBE_SITE_URL。默认值只服务本地开发，正式部署必填。
 */
const SITE_URL = process.env.PROBE_SITE_URL ?? "http://localhost:3210";

const TITLE = "探针 · Probe";
// 分享卡上的那两句话：一句口号定调，一句说清它到底给什么。
const DESCRIPTION = "见微，知著：每个数字都能点回原文。";

/**
 * openGraph / twitter 只写文案，图片交给文件约定：src/app/opengraph-image.png（1200×630）。
 * 手写 images 数组就要自己拼 basePath 与哈希，文件约定由 Next 负责，换部署路径不用改代码。
 */
export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: { default: TITLE, template: "%s · 探针" },
  description: DESCRIPTION,
  applicationName: "探针",
  openGraph: {
    type: "website",
    locale: "zh_CN",
    siteName: TITLE,
    title: TITLE,
    description: DESCRIPTION,
    // 子路径部署时 canonical 要带前缀：Next 只给打包出来的图片资源加 basePath，
    // 手写的这些字符串路径它不会改写。
    url: BASE_PATH + "/",
  },
  twitter: { card: "summary_large_image", title: TITLE, description: DESCRIPTION },
  appleWebApp: { capable: true, title: "探针", statusBarStyle: "black-translucent" },
  formatDetection: { telephone: false, email: false, address: false },
};

/**
 * viewportFit: "cover" 让 iPhone 的刘海/圆角不把内容裁掉 —— 代价是要自己给
 * 贴边元素留 safe-area（见 globals.css 的 .safe-top / .safe-bottom）。
 * colorScheme: "dark" 让浏览器把地址栏、滚动条、表单控件都按深色画，
 * 否则 iOS 上会在黑底上贴一条浅色地址栏。
 */
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#000000",
  colorScheme: "dark",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>
        {children}
        <SessionBar />
        <UpdateBanner />
        {/* 法律信息（备案号 / 隐私政策 / 用户协议）挂在 layout，每一页都在；产品页脚仍在 Workspace 里。 */}
        <SiteFooter />
      </body>
    </html>
  );
}
