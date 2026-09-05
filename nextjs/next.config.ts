import type { NextConfig } from "next";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const isLocal = process.env.NEXT_PUBLIC_MODE === 'local';

// 实际被打进产物的 book-index-ui 版本（取 node_modules 里解析到的那个，
// 而非 package.json 的 ^ 区间——区间说明不了线上跑的到底是哪一版）。
//
// 暴露它是为了让「线上前端到底是哪一版」可被直接查证：0.6.4 那次就是
// 数据侧字段已删、前端还是旧版在读，靠浏览器缓存掩盖了一阵子才发现。
// e2e 也用它做前置条件——断言新版行为的用例在旧版站点上自动跳过，
// 于是「先落用例、后升版本」这种两步发布不会再产生一次假红。
function resolveUiVersion(): string {
  // 不能 require('book-index-ui/package.json')：该包的 exports 没有导出
  // ./package.json，Node 会 ERR_PACKAGE_PATH_NOT_EXPORTED 直接抛。
  // 改为解析入口文件后向上找最近的 package.json，用 fs 读——绕开 exports 白名单，
  // 也不受包被提升到哪一层 node_modules 影响。
  try {
    const req = createRequire(import.meta.url);
    let dir = dirname(req.resolve('book-index-ui'));
    for (let i = 0; i < 6; i++) {
      try {
        const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf-8'));
        if (pkg.name === 'book-index-ui' && pkg.version) return pkg.version as string;
      } catch { /* 这一层没有或不是它，继续往上 */ }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch { /* 解析不到就落到下面的空值 */ }
  console.warn('[next.config] 解析不到 book-index-ui 版本，bim-ui-version 将为空');
  return '';
}

const uiVersion = resolveUiVersion();

const nextConfig: NextConfig = {
  // local mode 需要 API routes，不能用 static export
  ...(isLocal ? {} : { output: 'export' as const }),
  // 仅 local 模式打包 *.local.ts 文件（如 API routes，与 output: 'export' 不兼容）
  pageExtensions: isLocal
    ? ['tsx', 'ts', 'jsx', 'js', 'local.tsx', 'local.ts']
    : ['tsx', 'ts', 'jsx', 'js'],
  // GitHub Pages 部署路径处理
  basePath: process.env.NEXT_PUBLIC_BASE_PATH || '',

  env: {
    NEXT_PUBLIC_BIM_UI_VERSION: uiVersion,
  },

  // 转译 ESM 源码包（含 webtex-cn 源码 + book-index-ui 0.2.25 起 external 出去的 markdown 链路）
  transpilePackages: [
    'webtex-cn',
    'book-index-ui',
    'react-markdown',
    'remark-gfm',
  ],

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
