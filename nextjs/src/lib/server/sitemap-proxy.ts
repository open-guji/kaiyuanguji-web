/**
 * 条目 sitemap 的路由代理（overview#470 P1，设计 §1「sitemap」）。
 *
 * 背景：条目 sitemap 原来由代码构建时用打包好的数据生成、烘进产物（scripts/gen-sitemaps.mjs 写进 public/）。
 * 代码流程不再克隆打包数据以后，它没有来源；数据上线也刷不到它。改成：
 *   · 数据流程在打包时生成 sitemap，作为数据上传到数据前缀 `sitemaps/<名>.xml`
 *     （索引也在里面：`sitemaps/sitemap-index.xml`），<loc> 一律写正式站地址；
 *   · 站点上 `/sitemap-index.xml`、`/sitemaps/<名>.xml` 由中间件改写到 /sitemap-proxy/<名>，
 *     路由处理器从数据前缀取回来，把 <loc> 里的正式站地址换成本站（测试站读同一份数据，索引里的地址指向测试站），
 *     `s-maxage` 一小时——数据上线后 sitemap 自己跟着更新，不用再构建代码。
 * 只在构建时设了 NEXT_PUBLIC_SITEMAP_PROXY=1 才启用（SPLIT_DATA_FLOW 切换时由 deploy.yml 设）；
 * 不设就是现行的「public/ 里的静态文件」，行为不变。
 */

/** 数据前缀里存的 sitemap 用的站点地址（数据流程只生成这一份） */
export const STORED_SITE = 'https://www.kaiyuanguji.com';

/** 允许代理的名字：索引、四类条目分片、分类节点页分片。别的一律不代理（不能让路径拼出任意数据地址） */
// 序号至少三位（gen-sitemaps 按 padStart(3) 编号，超过 999 片会是四位以上）
const NAME_RE = /^(?:sitemap-index|(?:work|book|collection|entity)-\d{3,}|nodes-001)$/;

// 不带 stale-while-revalidate：数据上线后 sitemap 最迟一小时内换新（边缘 s-maxage），不再多挂一天旧的
export const SITEMAP_CACHE_CONTROL = 'public, max-age=300, s-maxage=3600';

export function isSitemapName(name: string): boolean {
    return NAME_RE.test(name);
}

/** 请求路径 → 代理用的名字；不是 sitemap 路径返回 null */
export function sitemapNameFromPath(pathname: string): string | null {
    if (pathname === '/sitemap-index.xml') return 'sitemap-index';
    const m = pathname.match(/^\/sitemaps\/([^/]+)\.xml$/);
    return m && isSitemapName(m[1]) ? m[1] : null;
}

/** 数据前缀里的地址 */
export function sitemapUpstreamUrl(base: string, name: string): string {
    return `${base.replace(/\/$/, '')}/sitemaps/${name}.xml`;
}

/** 把 <loc> 里的存储站点换成本站；两者相同时原样返回 */
export function rewriteSitemapSite(xml: string, from: string, to: string): string {
    const f = from.replace(/\/$/, '');
    const t = to.replace(/\/$/, '');
    if (f === t) return xml;
    return xml.split(`<loc>${f}/`).join(`<loc>${t}/`);
}

export type SitemapResult =
    | { ok: true; xml: string }
    | { ok: false; status: 404 | 502; reason: string };

/** 从数据前缀取一份 sitemap 并换成本站地址。404 原样回 404，其余失败回 502（不缓存错误） */
export async function fetchSitemap(opts: {
    base: string;
    name: string;
    site: string;
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
}): Promise<SitemapResult> {
    const { base, name, site, fetchImpl = fetch, timeoutMs = 8_000 } = opts;
    if (!isSitemapName(name)) return { ok: false, status: 404, reason: 'not a sitemap name' };
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
        const res = await fetchImpl(sitemapUpstreamUrl(base, name), { signal: ctl.signal, cache: 'no-store' });
        if (res.status === 404) return { ok: false, status: 404, reason: 'upstream 404' };
        if (!res.ok) return { ok: false, status: 502, reason: `upstream HTTP ${res.status}` };
        const xml = await res.text();
        if (!xml.trimStart().startsWith('<?xml')) return { ok: false, status: 502, reason: 'upstream is not xml' };
        // 截断或错误页：sitemap 必须以 </urlset>（分片）或 </sitemapindex>（索引）收尾。不做完整 XML 解析——
        // 边缘运行时没有 DOMParser，分片最大约 5 MB，这一道挡的是「传了一半」和「带声明的错误页」
        if (!/<\/(?:urlset|sitemapindex)>\s*$/.test(xml)) return { ok: false, status: 502, reason: 'upstream sitemap is truncated or malformed' };
        return { ok: true, xml: rewriteSitemapSite(xml, STORED_SITE, site) };
    } catch (e) {
        return { ok: false, status: 502, reason: e instanceof Error ? e.message : String(e) };
    } finally {
        clearTimeout(timer);
    }
}
