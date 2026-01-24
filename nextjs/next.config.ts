import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: 'export',
  // GitHub Pages 部署路径处理
  basePath: process.env.NEXT_PUBLIC_BASE_PATH || '',

  images: {
    unoptimized: true, // 静态导出需要禁用默认图片优化
    remotePatterns: [
      {
        protocol: "https",
        hostname: "raw.githubusercontent.com",
      },
    ],
  },
};

export default nextConfig;
