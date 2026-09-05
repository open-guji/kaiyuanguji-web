import type { Metadata } from "next";
import { Noto_Serif_SC } from "next/font/google";
import "./globals.css";
import { SITE_NAME, SITE_DESCRIPTION, SITE_URL } from "@/lib/constants";
import { SourceProvider } from "@/components/common/SourceContext";
import ErrorMonitor from "@/components/common/ErrorMonitor";

const notoSerif = Noto_Serif_SC({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700", "900"],
  display: "swap",
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
    <html lang="zh-CN">
      <head>
        {/* 线上前端版本的唯一可查证来源。运维排查（「线上到底是不是新版？」）
            和 e2e 前置条件都读它；由 next.config.ts 从 node_modules 实际解析
            到的 book-index-ui 版本注入，不是 package.json 里的 ^ 区间。 */}
        <meta name="bim-ui-version" content={process.env.NEXT_PUBLIC_BIM_UI_VERSION ?? ''} />
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
      <body className={`antialiased ${notoSerif.variable}`}>
        <ErrorMonitor />
        <SourceProvider>
          {children}
        </SourceProvider>
      </body>
    </html>
  );
}
