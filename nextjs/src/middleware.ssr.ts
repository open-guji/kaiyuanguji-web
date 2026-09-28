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
// FX1：/item/<id> 的整页导航也在这里跳——被并条目 308 到目标、已升格的草稿 id 308 到正式 id、
// 升格对照表查不了 307 回 /book-index。页面里本来就会跳，但 Next 的 ISR 页面在缓存未命中时
// 抛 redirect 会把 Location 写两遍（vercel/next.js#82117），EdgeOne 拼成「/item/x, /item/x」
// 并缓存到 CDN，浏览器跟随后 404。中间件出的 308 只有一个 Location。判断与页面同一套
// （lib/server/item-redirect.ts）；取数失败、非整页请求（RSC 导航、预取）一律放过交给页面。
import { NextResponse, type NextRequest } from 'next/server';
import { isValidItemId, parseItemId } from '@/lib/item-id';
import { createItemFetcher, defaultItemDataBase } from '@/lib/server/item-data';
import { resolveItemRedirect } from '@/lib/server/item-redirect';

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
// 中间件查不出来就放过，让页面自己取
let _fetcher: ReturnType<typeof createItemFetcher> | null = null;
function fetcher() {
    if (!_fetcher) _fetcher = createItemFetcher({ base: defaultItemDataBase(), timeoutMs: 3_000 });
    return _fetcher;
}

async function itemRedirect(req: NextRequest): Promise<NextResponse> {
    // RSC 导航与预取：页面的跳转编码在 RSC 负载里，不受 Location 重复影响，不必多查一次
    const dest = req.headers.get('sec-fetch-dest');
    if (dest && dest !== 'document') return NextResponse.next();
    const id = req.nextUrl.pathname.slice('/item/'.length);
    if (!isValidItemId(id)) return NextResponse.next();
    try {
        const f = fetcher();
        const r = await resolveItemRedirect(id, await f.getItem(id), f.resolvePromotion);
        if (!r) return NextResponse.next();
        return NextResponse.redirect(new URL(r.to, req.url), r.permanent ? 308 : 307);
    } catch (err) {
        console.warn(`[middleware] /item/${id} 跳转判断失败，交给页面：${(err as Error).message}`);
        return NextResponse.next();
    }
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

export function middleware(req: NextRequest): NextResponse | Promise<NextResponse> {
    return req.nextUrl.pathname.startsWith('/item/') ? itemRedirect(req) : bookIndexRedirect(req);
}

export const config = {
    matcher: ['/book-index', '/item/:id'],
};
