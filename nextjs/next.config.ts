import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // 允许从 GitHub 加载图片
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "raw.githubusercontent.com",
      },
    ],
  },
};

export default nextConfig;
