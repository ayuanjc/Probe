
import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";
import UpdateBanner from "@/components/UpdateBanner";

export const metadata: Metadata = {
  title: "探针 · Probe",
  description: "高置信度情报终端：每个数字都能点回原文。",
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
        <UpdateBanner />
      </body>
    </html>
  );
}
