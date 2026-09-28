// 构建信息（DBG，/api/version 与前端错误上报共用）：这次构建的网站代码 commit、
// book-index-ui 版本、构建时间、发往哪个站。
//
// 为什么「构建时写进文件」而不是读运行时环境变量：
//   - 正式站是静态导出＋edgeone-release 分支托管，边缘函数运行时根本没有 CI 的变量；
//   - 全栈站（staging／ssr-test）的 makers build 会把构建进程的整份 env 烘进函数，
//     但 ops/edgeone-fullstack-build.py 只放白名单变量进去（GITHUB_SHA 不在其中）。
// 所以 commit 用 `git rev-parse HEAD` 取（deploy.yml 的 checkout 就停在 web_ref 上），
// 直接把一行 `const BUILD_INFO = {...}` 写进 edge-functions/api/version.js 的标记区。
//
// 由 next.config.ts 在 `next build` 阶段调用（CI=true 时才改文件，本地 build 不弄脏工作区）。
// CommonJS：next.config.ts 经 createRequire 加载，jest 也直接 require。

const { execFileSync } = require('node:child_process');
const { existsSync, readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

const MARK_START = '// __BUILD_INFO_START__';
const MARK_END = '// __BUILD_INFO_END__';

function gitHead(cwd) {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().trim();
  } catch {
    return '';
  }
}

/**
 * 这次构建发往哪个站。与 deploy.yml 三条构建支路一一对应（不改 deploy.yml，只从已有变量推）：
 *   NEXT_PUBLIC_SITE_ENV=staging                 → staging（kyg-staging，全栈）
 *   KYG_RENDER_MODE=fullstack 且非 staging       → ssr-test（kyg-ssr-spike 双跑，全栈）
 *   其余（静态导出）                              → production（www，edgeone-release）
 * KYG_DEPLOY_TARGET 显式给了就以它为准（KYG_ 前缀能穿过全栈构建的白名单）。
 */
function resolveTarget(env) {
  if (env.KYG_DEPLOY_TARGET) return env.KYG_DEPLOY_TARGET;
  if (env.NEXT_PUBLIC_SITE_ENV === 'staging') return 'staging';
  if (env.KYG_RENDER_MODE === 'fullstack') return 'ssr-test';
  return 'production';
}

/**
 * @param {{ cwd?: string, env?: Record<string,string|undefined>, bimUi?: string, now?: Date }} opts
 */
function computeBuildInfo(opts = {}) {
  const env = opts.env || process.env;
  const web = /^[0-9a-f]{40}$/.test(env.KYG_WEB_COMMIT || '')
    ? env.KYG_WEB_COMMIT
    : (gitHead(opts.cwd || process.cwd()) || (/^[0-9a-f]{40}$/.test(env.GITHUB_SHA || '') ? env.GITHUB_SHA : ''));
  // 数据指针在 COS 上：staging 读 staging/ 前缀。只放公开 CDN 地址，/api/version 运行时去读
  const cosBase = String(env.NEXT_PUBLIC_COS_BASE || 'https://data.kaiyuanguji.com').replace(/\/+$/, '');
  return {
    web,
    bimUi: opts.bimUi || '',
    builtAt: (opts.now || new Date()).toISOString(),
    target: resolveTarget(env),
    dataBase: /^https:\/\/data\.kaiyuanguji\.com(\/staging)?$/.test(cosBase) ? cosBase : 'https://data.kaiyuanguji.com',
  };
}

/** 把 info 写进源码的标记区（幂等：反复写只替换标记之间那一行）。标记缺失时原样返回 null。 */
function injectBuildInfo(src, info) {
  const i = src.indexOf(MARK_START);
  const j = src.indexOf(MARK_END);
  if (i < 0 || j < 0 || j < i) return null;
  const line = `const BUILD_INFO = ${JSON.stringify(info)};`;
  return `${src.slice(0, i + MARK_START.length)}\n${line}\n${src.slice(j)}`;
}

/**
 * 写进每一份 edge-functions/api/version.js：仓库根那份（正式站 build 后 `cp -r edge-functions`）
 * 和 nextjs/edge-functions 那份（全栈构建前 `cp -r ../edge-functions ./edge-functions`）。
 * 返回实际写了的文件列表。
 */
function writeBuildInfo(nextjsDir, info) {
  const written = [];
  for (const f of [join(nextjsDir, '..', 'edge-functions', 'api', 'version.js'),
                   join(nextjsDir, 'edge-functions', 'api', 'version.js')]) {
    if (!existsSync(f)) continue;
    const out = injectBuildInfo(readFileSync(f, 'utf-8'), info);
    if (out === null) throw new Error(`${f} 里没有 BUILD_INFO 标记区，/api/version 会报「未写入版本信息」`);
    writeFileSync(f, out);
    written.push(f);
  }
  return written;
}

module.exports = { computeBuildInfo, injectBuildInfo, writeBuildInfo, resolveTarget, MARK_START, MARK_END };
