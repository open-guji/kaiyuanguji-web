import type { Metadata } from "next";
import { Suspense } from "react";
import { Noto_Sans_SC, Noto_Serif_SC } from "next/font/google";
import "./globals.css";
import { SITE_NAME, SITE_DESCRIPTION, SITE_URL, IS_STAGING } from "@/lib/constants";
import { SourceProvider } from "@/components/common/SourceContext";
import ErrorMonitor from "@/components/common/ErrorMonitor";
import Analytics from "@/components/common/Analytics";
import StagingBadge from "@/components/layout/StagingBadge";

// 全站黑体（N1）的兜底：系统没有中文黑体时才用到。只加载 400 / 700 两档，少下一套 CJK 字形。
// --fw-medium（500）按 CSS 字重匹配规则回落到 400，系统黑体有 500 的仍按 500 显示。
const notoSans = Noto_Sans_SC({
  subsets: ["latin"],
  weight: ["400", "700"],
  display: "swap",
  // 只做兜底（系统中文字体优先），不预加载
  preload: false,
  variable: "--font-noto-sans",
});

// 宋体只给整理本正文
const notoSerif = Noto_Serif_SC({
  subsets: ["latin"],
  weight: ["400", "700"],
  display: "swap",
  // 只做兜底（系统中文字体优先），不预加载
  preload: false,
  variable: "--font-noto-serif",
});

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: SITE_NAME,
    template: `%s - ${SITE_NAME}`,
  },
  description: SITE_DESCRIPTION,
  icons: {
    icon: "/images/open-guji-logo.png",
    apple: "/images/open-guji-logo.png",
  },
  keywords: ["古籍", "数字化", "开源", "传统文化", "古籍数字化"],
  authors: [{ name: SITE_NAME }],
  alternates: {
    canonical: "/",
  },
  openGraph: {
    title: SITE_NAME,
    description: SITE_DESCRIPTION,
    url: SITE_URL,
    siteName: SITE_NAME,
    images: [
      {
        url: "/images/og-image.png",
        width: 1200,
        height: 630,
        alt: SITE_NAME,
      },
    ],
    type: "website",
    locale: "zh_CN",
  },
  twitter: {
    card: "summary_large_image",
    title: SITE_NAME,
    description: SITE_DESCRIPTION,
    images: ["/images/og-image.png"],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // 静态导出环境下不能在 Server Component 中使用 cookies()
  return (
    // 字体变量类必须挂在 <html>：globals.css 在 :root 上用 var(--font-noto-sans) 拼 --font-sans，
    // 挂在 <body> 上时 :root 取不到，整条 --font-sans（连同 --bim-font-*）失效，
    // 全站退回 Tailwind 默认字体栈（INT 预合实测，overview#220）。
    <html lang="zh-CN" className={`${notoSans.variable} ${notoSerif.variable}`}>
      <head>
        {/* 线上前端版本的唯一可查证来源。运维排查（「线上到底是不是新版？」）
            和 e2e 前置条件都读它；由 next.config.ts 从 node_modules 实际解析
            到的 book-index-ui 版本注入，不是 package.json 里的 ^ 区间。 */}
        <meta name="bim-ui-version" content={process.env.NEXT_PUBLIC_BIM_UI_VERSION ?? ''} />
        {/* T1 测试站：不被搜索引擎收录（robots.txt 全禁是另一道闸，见 app/robots.ts） */}
        {IS_STAGING && <meta name="robots" content="noindex" />}
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: JSON.stringify({
              "@context": "https://schema.org",
              "@type": "WebSite",
              name: SITE_NAME,
              alternateName: ["开源古籍", "kaiyuanguji"],
              url: SITE_URL,
            }),
          }}
        />
      </head>
      <body className="antialiased">
        <StagingBadge />
        <ErrorMonitor />
        <Suspense fallback={null}>
          <Analytics />
        </Suspense>
        <SourceProvider>
          {children}
        </SourceProvider>
      </body>
    </html>
  );
}
