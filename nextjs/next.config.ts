import type { NextConfig } from "next";
import { PHASE_PRODUCTION_BUILD } from "next/constants";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const isLocal = process.env.NEXT_PUBLIC_MODE === 'local';

// 渲染模式（W2，31 卡 §A）：
//   - 不设（默认）＝静态导出 output: 'export'。正式站现行方式，产物与引入本开关前逐文件一致。
//   - KYG_RENDER_MODE=fullstack ＝全栈（测试站）：不静态导出，另把 *.ssr.tsx 当页面，
//     多出函数按请求渲染的 /item/[id]。其余页面仍在构建期预渲染成静态页。
// 注意：EdgeOne CLI 的 `makers deploy`（不给目录、自动构建）**不继承 shell 环境变量**，
// 只用控制台项目变量＋./.env——spike 分支当年只好把开关写死成 true，根因在此。
// deploy.yml 改为先 `edgeone makers build`（继承环境变量）再 `makers deploy .edgeone`。
const isFullstack = process.env.KYG_RENDER_MODE === 'fullstack';

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

// DBG：构建信息（web commit／bimUi／builtAt／target），见 scripts/lib/build-info.cjs。
// 前端错误上报带上 web；next build 阶段在 CI 里把同一份写进 edge-functions/api/version.js。
const { computeBuildInfo, writeBuildInfo } = createRequire(import.meta.url)('./scripts/lib/build-info.cjs');
const buildInfo = computeBuildInfo({ cwd: process.cwd(), bimUi: uiVersion });

const nextConfig: NextConfig = {
  // local mode 需要 API routes、fullstack 要函数渲染，都不能用 static export
  ...(isLocal || isFullstack ? {} : { output: 'export' as const }),
  // 仅 local 模式打包 *.local.ts 文件（如 API routes，与 output: 'export' 不兼容）；
  // 仅 fullstack 模式打包 *.ssr.tsx 页面（动态路由，静态导出下会构建失败）
  pageExtensions: [
    'tsx', 'ts', 'jsx', 'js',
    ...(isLocal ? ['local.tsx', 'local.ts'] : []),
    ...(isFullstack ? ['ssr.tsx', 'ssr.ts'] : []),
  ],
  // 部署子路径（basePath）。历史上为 GitHub Pages 的 /repo/ 子路径而设；
  // 现托管在 EdgeOne Pages 根路径，CI 里显式 NEXT_PUBLIC_BASE_PATH=""。
  basePath: process.env.NEXT_PUBLIC_BASE_PATH || '',

  env: {
    NEXT_PUBLIC_BIM_UI_VERSION: uiVersion,
    NEXT_PUBLIC_WEB_COMMIT: buildInfo.web,
    // 渲染模式在构建期内联：EdgeOne 运行时拿不到 CI 的构建环境变量（见上面 KYG_RENDER_MODE 的注释），
    // 代码里读 process.env.KYG_RENDER_MODE（如 book-index 的 generateMetadata）要靠它。不是机密。
    KYG_RENDER_MODE: process.env.KYG_RENDER_MODE || '',
    // W2-3：条目页按需失效接口（app/internal/revalidate/route.ssr.ts）的密钥，只在全栈构建注入。
    // 构建期写进服务端代码：EdgeOne 运行时只有控制台项目变量，拿不到 CI 的环境变量。
    // 只有服务端路由引用它，不会进浏览器端 chunk。
    ...(isFullstack ? { KYG_REVALIDATE_SECRET: process.env.KYG_REVALIDATE_SECRET || '' } : {}),
  },

  // 转译 ESM 源码包（含 webtex-cn 源码 + book-index-ui 0.2.25 起 external 出去的 markdown 链路）
  transpilePackages: [
    'webtex-cn',
    'book-index-ui',
    'react-markdown',
    'remark-gfm',
  ],

  // S2 实验（overview#280）：条目页不带 stale-while-revalidate，只留 s-maxage=3600。
  // 线上实测 EdgeOne 对带 swr 的条目页 ISR 响应不做 gzip／br（预渲染、无 swr 的响应会压），推断是这个缓存头挡了压缩。
  // 只在全栈构建里生效（静态导出不支持 headers()）。代价：过期后第一个请求要等重渲染，不再先返回旧页。
  // 没效果就撤回（同一处删掉）。
  ...(isFullstack
    ? {
        async headers() {
          return [{ source: '/item/:id', headers: [{ key: 'Cache-Control', value: 'public, s-maxage=3600' }] }];
        },
      }
    : {}),

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

export default function config(phase: string): NextConfig {
  // 只在 CI 的 next build 里改文件：本地 build 不弄脏工作区；jest（next/jest 也会加载本文件）不触发
  if (phase === PHASE_PRODUCTION_BUILD && process.env.CI === 'true') {
    const written: string[] = writeBuildInfo(process.cwd(), buildInfo);
    console.log(`[next.config] 构建信息 web=${buildInfo.web.slice(0, 12) || '（空）'} target=${buildInfo.target} → ${written.length} 份 version.js`);
  }
  return nextConfig;
}
