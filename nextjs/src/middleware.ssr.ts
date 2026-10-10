// W2-2（31 卡 §A）：旧详情地址 /book-index?id=<id> → 308 /item/<id>。
//
// 文件名带 .ssr：只有全栈构建（KYG_RENDER_MODE=fullstack，测试站）才认它为中间件
// （Next 按 pageExtensions 找 middleware 文件）；正式站静态导出没有中间件，行为不变。
// EdgeOne 不支持 next.config 的 redirects（31 卡 §B.1），跳转只能写在这里。
//
// 只改写「查询串恰好只有一个合法、正式 id」的请求：
//   - 带 tab／juan／page／mode 等参数的，是详情组件自己的 URL 同步（它仍往 /book-index 推），
//     改写会丢状态，放过；
//   - 草稿 id 可能已升格，要客户端查升格表，放过（/item/<草稿 id> 查不到时也会跳回这里）；
//   - redirected_from／no_redirect 是升格横幅的往返，放过；
//   - **站内来的请求放过**（Referer 与本站同源，或 Sec-Fetch-Dest 不是 document）。
//     308 的目的是把站外入口（搜索引擎、外部旧链接、直接输入）归到规范地址；
//     站内的点击与 RSC 预取是详情组件自己的导航（UI 冻结，它仍用 /book-index），
//     改写它们只会多一跳、改掉地址栏。09-27 web#58 合入后测试站 e2e 红了 3 条正是这个：
//     预取 /book-index?id= 被 308 成 /item/<id>，一页多出二三十个 /item/ 请求；
//     面包屑点击后地址栏也变了。注意 Next 会在中间件里剥掉 RSC 请求头与 _rsc 参数，
//     只能靠浏览器自带、Next 不剥的 Referer／Sec-Fetch-Dest 来判断。
//
// N5b：旧阅读入口 ?tab=fulltext／collated → 308 新路径式地址（readerRedirect；阅读页在一级目录 /read/<id>，overview#267；
// overview#307 E 块起地址是 /read/<id>[/<key>][/<章>]，版本与章号按该条目的 manifest 换算，见 lib/legacy-reader.ts）。
//
// FX1：/item/<id> 的整页导航也在这里跳——被并条目 308 到目标、已升格的草稿 id 308 到正式 id、
// 升格对照表查不了 307 回 /book-index。页面里本来就会跳，但 Next 的 ISR 页面在缓存未命中时
// 抛 redirect 会把 Location 写两遍（vercel/next.js#82117），EdgeOne 拼成「/item/x, /item/x」
// 并缓存到 CDN，浏览器跟随后 404。中间件出的 308 只有一个 Location。判断与页面同一套
// （lib/server/item-redirect.ts）；取数失败、非整页请求（RSC 导航、预取）一律放过交给页面。
import { NextResponse, type NextRequest } from 'next/server';
import { isValidItemId, parseItemId } from '@/lib/item-id';
import { createItemFetcher, defaultItemDataBase } from '@/lib/server/item-data';
import { lookupItemRedirectTraced } from '@/lib/server/item-redirect';
import { legacyMarkdownName, markdownPagePath } from '@/lib/markdown-pages';
import { bookIndexFallbackPath, cleanItemSearch } from '@/lib/item-query';
import { parseReaderSegments, readerPath, splitReaderPathname, type ReaderSel } from '@/lib/reader-route';
import { legacyReaderTarget, parseLegacyReaderParams, parseLegacyTab, type LegacyReaderRef } from '@/lib/legacy-reader';
import { getManifest } from '@/lib/server/reader-check';
import { sitemapNameFromPath } from '@/lib/server/sitemap-proxy';
import { canonicalRedirectTarget } from '@/lib/site-hosts';

/** 请求是否来自本站页面（站内点击、预取）或不是整页导航 */
function isInSite(req: NextRequest): boolean {
    const dest = req.headers.get('sec-fetch-dest');
    if (dest && dest !== 'document') return true;
    const ref = req.headers.get('referer');
    if (!ref) return false;
    try {
        return new URL(ref).host === (req.headers.get('host') || req.nextUrl.host);
    } catch {
        return false;
    }
}

// 边缘运行时的取数实例：指针 60 秒、不可变对象 LRU，跨请求复用。超时比页面（8 秒）短：
// 中间件查不出来就放过，让页面自己取。
// forceCache: false —— 边缘运行时里 cache: 'force-cache' 可能直接抛错，被下面的 catch
// 静默放过，结果等于中间件从不跳、没修。
//
// FX1c：FX1 上线后测试站被并条目仍是页面出的双 Location——中间件的 /item 分支在 EdgeOne
// 边缘运行时里调 AbortSignal.timeout 抛错（那里没有这个静态方法；本地 next start 与 Node 模拟
// 都有，复现不了），被下面的 catch 静默放过。item-data 已改为缺时退回 AbortController。
// 当时靠测试站诊断响应头证实（rt:poly），根因证实后已删。
let _fetcher: ReturnType<typeof createItemFetcher> | null = null;
function fetcher() {
    if (!_fetcher) _fetcher = createItemFetcher({ base: defaultItemDataBase(), timeoutMs: 3_000, forceCache: false, retries: 0 });
    return _fetcher;
}

/**
 * 被并／升格跳转的判断（overview#322「首次打开报错、刷新就好」，overview#491）：
 * - 取条目只走 current/（latest.json → current/entry，2 跳）；草稿 id 的升格对照表与它并行查。
 *   10-02 正式站实测：冷 id 的整页请求 2% 被边缘直接断开（无响应头），中间件不取数的同批请求 0 断，
 *   冷边缘实例上串着发的子请求越少越好。
 * - 整段判断限时 REDIRECT_BUDGET_MS，到时放行交给页面（页面里同一套跳转兜底），不让整页请求挂在边缘上等子请求。
 *   2s 时测试站抽样仍有 6/10、正式站 3/10 的旧 id 整页请求在预算内没出结果（诊断头 pass:budget(2000ms,entry=miss,promo=pending)，
 *   对照表 3 跳串行没返回）；升格查表改走 current/promotions 分片（深度 2）之后放宽到 3s，仍留足余量不让请求挂在边缘上。
 * - 每个 /item 响应都带 x-kyg-item-redirect 头说明跳或不跳的原因（见 lookupItemRedirectTraced）。
 * - 草稿 id 在预算内没有定论（pass:budget／pass:error）时不再放给页面：页面在 ISR 缓存未命中时抛 permanentRedirect 会把 Location
 *   写两遍，并被 CDN 缓存（s-maxage 3600、durable）；这里改出一个不缓存的 307 到 /book-index?id=<id>，由客户端查升格表
 *   （与对照表查不了时的 307 是同一条路）。正式 id（被并条目）没有这条退路（/book-index?id=<正式 id> 会 308 回来），仍交给页面。
 */
const REDIRECT_BUDGET_MS = 3_000;
const REASON_HEADER = 'x-kyg-item-redirect';

const lookupItemRedirect = (id: string) => lookupItemRedirectTraced(id, fetcher(), REDIRECT_BUDGET_MS);

async function itemRedirect(req: NextRequest): Promise<NextResponse> {
    // RSC 导航与预取：页面的跳转编码在 RSC 负载里，不受 Location 重复影响，不必多查一次
    const dest = req.headers.get('sec-fetch-dest');
    if (dest && dest !== 'document') return NextResponse.next();
    const id = req.nextUrl.pathname.slice('/item/'.length);
    if (!isValidItemId(id)) return NextResponse.next();
    const { redirect: r, reason } = await lookupItemRedirect(id);
    const undecided = !r && (reason.startsWith('pass:budget') || reason.startsWith('pass:error'));
    const tempFallback = undecided && parseItemId(id)?.status === 'draft';
    if (undecided) {
        console.warn(`[middleware] /item/${id} 跳转判断没出结果，${tempFallback ? '临时 307 交给客户端查表' : '交给页面'}：${reason}`);
    }
    // 被并／升格的跳转目标本身就是干净地址，一步到位，不会再多跳一次去查询串
    let res: NextResponse;
    // 回 /book-index 的 307（对照表查不了、预算内没定论）带上白名单里的详情状态参数，外部链接带的视图不丢
    const fallback = () => NextResponse.redirect(new URL(bookIndexFallbackPath(id, req.nextUrl.searchParams), req.url), 307);
    if (r) res = r.permanent ? NextResponse.redirect(new URL(r.to, req.url), 308) : fallback();
    else if (tempFallback) res = fallback();
    else res = itemQueryRedirect(req);
    // 307 是「现在还不知道」的临时答案，不能进 CDN
    if (res.status === 307) noStore(res);
    res.headers.set(REASON_HEADER, tempFallback ? `${reason};fallback:307` : reason);
    return res;
}

function noStore(res: NextResponse): void {
    res.headers.set('Cache-Control', 'no-store');
    res.headers.set('Eo-Cdn-Cache-Control', 'no-store');
}

/**
 * S1（overview#280）：条目页带白名单之外的查询参数 → 308 到只留白名单参数的地址，
 * 让 CDN 只缓存一份（见 lib/item-query.ts）。只处理整页导航；取数失败也照跳，与数据无关。
 */
function itemQueryRedirect(req: NextRequest): NextResponse {
    const cleaned = cleanItemSearch(req.nextUrl.searchParams);
    if (cleaned === null) return NextResponse.next();
    const url = req.nextUrl.clone();
    url.search = cleaned;
    return NextResponse.redirect(url, 308);
}

function bookIndexRedirect(req: NextRequest): NextResponse {
    if (isInSite(req)) return NextResponse.next();
    const params = req.nextUrl.searchParams;
    const keys = Array.from(params.keys());
    if (keys.length !== 1 || keys[0] !== 'id') return NextResponse.next();
    const id = params.get('id') ?? '';
    if (parseItemId(id)?.status !== 'official') return NextResponse.next();
    const url = req.nextUrl.clone();
    url.pathname = `/item/${id}`;
    url.search = '';
    return NextResponse.redirect(url, 308);
}

/**
 * 旧引用 → 新路径式地址的 308。版本与章号按该条目的 manifest 换算（lib/legacy-reader.ts）；
 * 条目没有 manifest（没有文本）就 308 到条目页 /item/<id>（阅读页那里只会是 404）。
 * 取数出错返回 null，交给页面判断，不在这里替它下结论。
 */
async function legacyRedirect(req: NextRequest, ref: LegacyReaderRef): Promise<NextResponse | null> {
    try {
        const f = fetcher();
        const manifest = await getManifest(ref.id, (p) => f.getCurrentJson(p));
        const target = legacyReaderTarget(ref, manifest) ?? `/item/${ref.id}`;
        return NextResponse.redirect(new URL(target, req.url), 308);
    } catch (err) {
        console.warn(`[middleware] ${ref.id} 旧阅读地址换算失败，交给页面：${(err as Error).message}`);
        return null;
    }
}

/**
 * N5b：旧阅读入口（?tab=fulltext／collated，/book-index 与 /item/<id> 都算）→ 308 新阅读页地址，一步到位。
 * 与上面两条不同，站内请求也跳：条目页的 tab 与卷切换仍往 /book-index?…&tab= 推（组件不在本道写域），
 * 客户端导航拿到 308 后 Next 会跟到新地址——阅读器从此只有一处。
 */
async function readerRedirect(req: NextRequest): Promise<NextResponse | null> {
    const ref = parseLegacyTab(req.nextUrl.pathname, req.nextUrl.searchParams);
    return ref ? legacyRedirect(req, ref) : null;
}

/**
 * 阅读页地址的整理（overview#267／#307）：
 *   - /item/<id>/read?…（上一版的阅读页地址）→ 按旧查询串（kind／key／juan）换算成新路径，没带旧参数就是 /read/<id>；
 *   - /read/<id>?kind=…&key=…&juan=…（上一版的查询串形式）→ 同上换算；
 *   - /read/<id>/default[/<章>] → 不带 default 的形式（只做字符串换算，不查数据）；
 *   - /read/<说明页名>（旧的 public/content 说明页，与阅读页同一层）→ 308 /read/md/<名>；
 *   - /read/<被并条目／已升格草稿>[/…] → 目标条目的阅读页（readerItemRedirect）。
 * 页面里也有同样的跳转，这里先出一个只有单个 Location 的 308
 * （EdgeOne 上页面抛 redirect 会把 Location 写两遍，见上面 FX1）。
 */
async function readerPathRedirect(req: NextRequest): Promise<NextResponse | null> {
    const { pathname, searchParams } = req.nextUrl;
    const legacyId = pathname.match(/^\/item\/([^/]+)\/read\/?$/)?.[1];
    if (legacyId) {
        const ref = parseLegacyReaderParams(legacyId, searchParams);
        if (!ref) return NextResponse.redirect(new URL(readerPath(legacyId), req.url), 308);
        return legacyRedirect(req, ref);
    }
    const p = splitReaderPathname(pathname);
    if (!p) return null;
    if (p.segs.length === 0) {
        const md = legacyMarkdownName(p.id);
        if (md) return NextResponse.redirect(new URL(markdownPagePath(md), req.url), 308);
        const ref = parseLegacyReaderParams(p.id, searchParams);
        // 阅读页是 ISR、不读查询串（overview#322），旧查询串只能在这里换算：取数出错就临时跳条目页，别发会被缓存的 308
        if (ref) return (await legacyRedirect(req, ref)) ?? NextResponse.redirect(new URL(`/item/${p.id}`, req.url), 307);
    }
    const parsed = parseReaderSegments(p.id, p.segs);
    if (!parsed) return null;
    if ('redirect' in parsed) return NextResponse.redirect(new URL(parsed.redirect, req.url), 308);
    return readerItemRedirect(req, p.id, parsed.sel);
}

/**
 * 阅读页的被并条目／草稿升格跳转（overview#322）：阅读页改成 ISR 后，页面在缓存未命中时抛 redirect
 * 会把 Location 写两遍（同 FX1），所以整页导航与 /item 一样由这里先跳，落到目标的阅读页。
 * RSC 导航、预取与取数出错一律放过交给页面。
 */
async function readerItemRedirect(req: NextRequest, id: string, sel: ReaderSel): Promise<NextResponse | null> {
    const dest = req.headers.get('sec-fetch-dest');
    if (dest && dest !== 'document') return null;
    const { redirect: r, reason } = await lookupItemRedirect(id);
    if (!r) {
        if (reason.startsWith('pass:budget') || reason.startsWith('pass:error')) {
            console.warn(`[middleware] /read/${id} 跳转判断没出结果，交给页面：${reason}`);
        }
        return null;
    }
    const target = r.to.match(/^\/item\/([0-9a-z]+)$/)?.[1];
    const res = NextResponse.redirect(new URL(target ? readerPath(target, sel) : r.to, req.url), r.permanent ? 308 : 307);
    if (!r.permanent) noStore(res);
    return res;
}

const isReaderPath = (pathname: string) => /^\/item\/[^/]+\/read\/?$/.test(pathname) || /^\/read\/[^/]+(\/[^/]+)*\/?$/.test(pathname);

// overview#470 P1：条目 sitemap 走路由代理（lib/server/sitemap-proxy.ts）。构建时设了 NEXT_PUBLIC_SITEMAP_PROXY=1 才改写；
// 不设就是 public/ 里的静态文件（现行），这里放过。matcher 必须是字面量，所以路径总是进中间件，由这个开关决定动不动。
const SITEMAP_PROXY = process.env.NEXT_PUBLIC_SITEMAP_PROXY === '1';

function sitemapRewrite(req: NextRequest): NextResponse {
    const name = SITEMAP_PROXY ? sitemapNameFromPath(req.nextUrl.pathname) : null;
    if (!name) return NextResponse.next();
    return NextResponse.rewrite(new URL(`/sitemap-proxy/${name}`, req.url));
}

const isHandledPath = (pathname: string) =>
    pathname === '/book-index' || pathname === '/sitemap-index.xml' ||
    pathname.startsWith('/item/') || pathname.startsWith('/read/') || pathname.startsWith('/sitemaps/');

export async function middleware(req: NextRequest): Promise<NextResponse> {
    // 主域名迁移（overview#275）：旧域名与新域名裸域的页面请求 301 到 www.openguji.com 的同一路径，必须最先判断
    const canonical = canonicalRedirectTarget({
        host: req.headers.get('x-forwarded-host') || req.headers.get('host') || req.nextUrl.host,
        method: req.method,
        pathname: req.nextUrl.pathname,
        search: req.nextUrl.search,
    });
    if (canonical) return NextResponse.redirect(canonical, 301);
    // matcher 末项为域名跳转放宽到了所有页面路径；下面的条目／阅读／sitemap 处理仍只管原来的那几类路径，别的直接放过
    if (!isHandledPath(req.nextUrl.pathname)) return NextResponse.next();
    if (req.nextUrl.pathname === '/sitemap-index.xml' || req.nextUrl.pathname.startsWith('/sitemaps/')) return sitemapRewrite(req);
    if (isReaderPath(req.nextUrl.pathname)) return (await readerPathRedirect(req)) ?? NextResponse.next();
    const reader = await readerRedirect(req);
    if (reader) return reader;
    return req.nextUrl.pathname.startsWith('/item/') ? itemRedirect(req) : bookIndexRedirect(req);
}

export const config = {
    // 末项是「除接口、登录、Next 静态资源外的所有路径」，给域名跳转用（canonicalRedirectTarget 按主机判断，其它主机放过）；
    // 前面各项是原来的条目／阅读／sitemap 路径，保留是为了它们仍各自命中、顺序不变。
    matcher: [
        '/book-index', '/item/:id', '/item/:id/read', '/read/:id/:path*', '/sitemap-index.xml', '/sitemaps/:name',
        '/((?!api/|oauth/|\\.well-known/|_next/).*)',
    ],
};
