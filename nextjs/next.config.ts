import type { NextConfig } from "next";

const isLocal = process.env.NEXT_PUBLIC_MODE === 'local';

const nextConfig: NextConfig = {
  // local mode 需要 API routes，不能用 static export
  ...(isLocal ? {} : { output: 'export' as const }),
  // 仅 local 模式打包 *.local.ts 文件（如 API routes，与 output: 'export' 不兼容）
  pageExtensions: isLocal
    ? ['tsx', 'ts', 'jsx', 'js', 'local.tsx', 'local.ts']
    : ['tsx', 'ts', 'jsx', 'js'],
  // GitHub Pages 部署路径处理
  basePath: process.env.NEXT_PUBLIC_BASE_PATH || '',

  // 转译 webtex-cn 源码（ES modules）
  transpilePackages: ['webtex-cn', 'book-index-ui'],

  images: {
    unoptimized: true, // 静态导出需要禁用默认图片优化
    qualities: [75, 90],
    remotePatterns: [
      {
        protocol: "https",
        hostname: "raw.githubusercontent.com",
      },
    ],
  },
};

export default nextConfig;
