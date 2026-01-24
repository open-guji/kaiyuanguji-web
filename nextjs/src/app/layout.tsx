import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "开源古籍",
    template: "%s - 开源古籍",
  },
  description:
    "开源古籍项目通过技术手段推动古籍的数字化、校对及开源存储，致力于让传统文化触手可及。",
  keywords: ["古籍", "数字化", "开源", "传统文化", "古籍数字化"],
  authors: [{ name: "开源古籍" }],
  openGraph: {
    title: "开源古籍",
    description: "让古籍数字化更简单",
    type: "website",
    locale: "zh_CN",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
