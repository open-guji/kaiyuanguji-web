/**
 * /item/<id> 该不该跳、跳去哪（FX1）。条目页（page.ssr.tsx）与中间件（middleware.ssr.ts）共用一套判断。
 *
 * 为什么中间件也要跳：Next 的 ISR 页面在缓存未命中那次渲染里抛 redirect／permanentRedirect，
 * 会把 Location 写两遍——渲染时 setHeader 一次，渲染完又从缓存条目的 headers 里 appendHeader 一次
 * （vercel/next.js#82117，16.1.4 与 16.3.6 都还在）。本地 next start 是两行 location，
 * EdgeOne 云函数把它们拼成「/item/x, /item/x」，CDN 再把这份缓存 1 小时。
 * 中间件自己出的 308 只有一个 Location，所以整页导航的跳转改由中间件先做；
 * 页面里的跳转留作兜底（RSC 导航不经中间件跳转，它的跳转编码在 RSC 负载里，不受影响）。
 *
 * 中间件跑在边缘运行时：这里只引纯函数模块（item-id、item-seo 的 mergedTarget），不引 book-index-ui。
 */
import { parseItemId } from '../item-id';
import type { ItemFetchResult, PromotionLookup } from './item-data';
import { mergedTarget } from './item-seo';

export interface ItemRedirect {
    /** 站内路径 */
    to: string;
    /** true＝308（被并条目、已升格草稿）；false＝307（升格对照表查不了，回 /book-index 由客户端查） */
    permanent: boolean;
}

/**
 * 给定取数结果，算出跳转；null ＝ 不跳（hit 为 null 时就是 404）。
 * 只有「查不到的草稿 id」才会去查升格对照表（getPromotion）。
 */
export async function resolveItemRedirect(
    id: string,
    hit: ItemFetchResult | null,
    getPromotion: (id: string) => Promise<PromotionLookup>,
): Promise<ItemRedirect | null> {
    if (hit) {
        const target = mergedTarget(hit.entry, id);
        return target ? { to: `/item/${target}`, permanent: true } : null;
    }
    // 草稿 id 多半已升格：查 h1 里对应的一片对照表（31 卡 §A.6 第 5 条）
    if (parseItemId(id)?.status !== 'draft') return null;
    const p = await getPromotion(id);
    if (p.status === 'promoted') return { to: `/item/${p.to}`, permanent: true };
    // 查不了：临时（307）跳回 /book-index，由客户端查表；中间件不改写草稿 id，不会绕回来
    if (p.status === 'unknown') return { to: `/book-index?id=${id}`, permanent: false };
    return null;
}
