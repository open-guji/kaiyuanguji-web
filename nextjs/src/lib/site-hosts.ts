/**
 * 主域名迁移（overview#275）：kaiyuanguji.com → openguji.com。
 *
 * 读者看得见的域名只有 www／裸域／staging；data.、api. 仍留在 kaiyuanguji.com（后台跨域调用，读者看不见）。
 * 旧域名的页面请求一律 301 到新域名的同一路径（保留查询串），并在地址后加 MOVED_HASH，
 * 新站据此在页面最上方显示一条窄横幅（components/layout/MovedBanner）。
 * 用 # 片段而不是查询参数：片段不会发给服务器，不污染 CDN 缓存键，也不会被条目页的「只留白名单参数」308 剥掉。
 */

/** 新的规范主机 */
export const CANONICAL_HOST = 'www.openguji.com';

/** 要 301 到规范主机的主机：旧域名的 www、裸域，以及新域名的裸域 */
const REDIRECT_HOSTS = new Set(['www.kaiyuanguji.com', 'kaiyuanguji.com', 'openguji.com']);

/** 旧域名主机（只有它们跳转后才带横幅片段；新域名裸域跳到 www 不带） */
const LEGACY_HOSTS = new Set(['www.kaiyuanguji.com', 'kaiyuanguji.com']);

/** 跳转后附在地址上的片段，横幅据此显示 */
export const MOVED_HASH = '#from-kaiyuanguji';

/**
 * 不跳的路径前缀：接口与登录（脚本、OAuth 客户端、监控按旧域名调用，POST 经 301 会变 GET；OAuth 的 iss 也仍是旧域名）、
 * Next 静态资源（页面都跳了，它们不会再被旧域名的页面引用）。
 */
const KEEP_PREFIXES = ['/api/', '/oauth/', '/.well-known/', '/_next/'];

/** 去掉端口、转小写 */
export function normalizeHost(host: string | null | undefined): string {
    return (host ?? '').split(':')[0].trim().toLowerCase();
}

/**
 * 这个请求要不要跳到规范主机；要就返回完整目标地址，不要返回 null。
 * 只跳 GET／HEAD（整页导航与预取）；方法不是这两种、或路径在保留前缀里一律放过。
 */
export function canonicalRedirectTarget(opts: {
    host: string | null | undefined;
    method: string;
    pathname: string;
    search: string;
}): string | null {
    const host = normalizeHost(opts.host);
    if (!REDIRECT_HOSTS.has(host)) return null;
    if (opts.method !== 'GET' && opts.method !== 'HEAD') return null;
    if (KEEP_PREFIXES.some((p) => opts.pathname.startsWith(p))) return null;
    const hash = LEGACY_HOSTS.has(host) ? MOVED_HASH : '';
    return `https://${CANONICAL_HOST}${opts.pathname}${opts.search}${hash}`;
}
