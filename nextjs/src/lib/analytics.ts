/**
 * 第三方访问统计（G-24 第一期）：百度统计管国内，GA4 管海外。
 *
 * 站点 ID 由构建时环境变量注入（deploy.yml 从仓库 Variables 读），不是凭证，出现在页面里无妨。
 * 没配 ID 时整套不加载——本地开发、预览构建默认不统计。
 *
 * 不统计的情形（与错误监控 error-report.ts 同一口径，免得自己人和测试给数据注水）：
 *   - 自动化浏览器（navigator.webdriver）：e2e / perf 每次部署都会跑
 *   - 管理与内部页：/admin、/join
 *   - 读者明确拒绝追踪：Do Not Track 或 Global Privacy Control
 */

export const BAIDU_TONGJI_ID = process.env.NEXT_PUBLIC_BAIDU_TONGJI_ID || '';
export const GA_ID = process.env.NEXT_PUBLIC_GA_ID || '';

/** 这些脚本被广告拦截器挡掉时，错误监控不该记成「资源加载失败」 */
export const ANALYTICS_HOSTS = ['hm.baidu.com', 'www.googletagmanager.com', 'www.google-analytics.com'];

const EXCLUDED_PREFIXES = ['/admin', '/join'];

export function isExcludedPath(pathname: string): boolean {
  return EXCLUDED_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

export function optedOut(nav: Navigator): boolean {
  const n = nav as Navigator & { globalPrivacyControl?: boolean; msDoNotTrack?: string };
  const w = typeof window !== 'undefined' ? (window as Window & { doNotTrack?: string }) : undefined;
  const dnt = n.doNotTrack ?? w?.doNotTrack ?? n.msDoNotTrack;
  return n.globalPrivacyControl === true || dnt === '1' || dnt === 'yes';
}

export function shouldTrack(pathname: string, nav: Navigator): boolean {
  try {
    if (nav.webdriver === true) return false;
    if (isExcludedPath(pathname)) return false;
    if (optedOut(nav)) return false;
    return true;
  } catch {
    return false;
  }
}

export function isAnalyticsUrl(url?: string): boolean {
  if (!url) return false;
  try {
    return ANALYTICS_HOSTS.includes(new URL(url).hostname);
  } catch {
    return false;
  }
}
