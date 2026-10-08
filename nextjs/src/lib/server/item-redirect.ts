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

/** lookupItemRedirectTraced 用到的取数能力（createItemFetcher 的返回值满足它） */
export interface ItemRedirectDeps {
    getItem(id: string, opts?: { prefer?: 'current'; currentOnly?: boolean }): Promise<ItemFetchResult | null>;
    resolvePromotion(id: string): Promise<PromotionLookup>;
}

export interface TracedRedirect {
    redirect: ItemRedirect | null;
    /**
     * 为什么跳／为什么没跳，写进响应头 x-kyg-item-redirect 给线上排查用（FX1c 当年要靠临时诊断头才查出根因）。
     * redirect:merged | redirect:promoted | redirect:promo-unknown（307）；
     * pass:entry-ok | pass:not-found | pass:promo-absent | pass:budget(...) | pass:error:<摘要>。
     */
    reason: string;
}

/** 响应头值只留可见 ASCII，限长 */
function headerSafe(text: string, max = 80): string {
    return text.replace(/[^\x20-\x7e]+/g, '?').slice(0, max);
}

/**
 * 中间件的跳转判断：整段限时 budgetMs，到时放行交给页面（页面里同一套跳转兜底）。
 *
 * 取数顺序（overview#491）：草稿 id 的升格对照表与条目查询**同时**发出，不再先后串行——
 * 已升格的草稿 id 在 current/ 与 h1 里都没有条目，原先要白走完条目这一串才轮到对照表，
 * 冷边缘上串行 6 跳超出预算，被静默放过，页面在 ISR 缓存未命中时出双 Location。
 * 条目只问 current/（currentOnly）：中间件只凭肯定的答案跳，查不出就放过。
 * 对照表在非草稿 id 上不查，条目命中时的结果不用（resolveItemRedirect 只在查不到条目时才看它）。
 */
export async function lookupItemRedirectTraced(
    id: string,
    deps: ItemRedirectDeps,
    budgetMs: number,
): Promise<TracedRedirect> {
    const isDraft = parseItemId(id)?.status === 'draft';
    let promo: PromotionLookup | undefined;
    let entry: 'pending' | 'hit' | 'miss' = 'pending';

    // resolvePromotion 自己吞掉错误（返回 unknown），不会 reject
    const promotion = isDraft ? deps.resolvePromotion(id) : null;
    promotion?.then((p) => { promo = p; }, () => {});

    let timer: ReturnType<typeof setTimeout> | undefined;
    const budget = new Promise<TracedRedirect>((resolve) => {
        timer = setTimeout(() => {
            resolve({ redirect: null, reason: `pass:budget(${budgetMs}ms,entry=${entry},promo=${promo?.status ?? 'pending'})` });
        }, budgetMs);
    });

    const work = (async (): Promise<TracedRedirect> => {
        try {
            const hit = await deps.getItem(id, { prefer: 'current', currentOnly: true });
            entry = hit ? 'hit' : 'miss';
            const redirect = await resolveItemRedirect(id, hit, (i) => promotion ?? deps.resolvePromotion(i));
            if (redirect) {
                if (!redirect.permanent) return { redirect, reason: 'redirect:promo-unknown' };
                return { redirect, reason: hit ? 'redirect:merged' : 'redirect:promoted' };
            }
            if (hit) return { redirect, reason: 'pass:entry-ok' };
            return { redirect, reason: isDraft ? `pass:promo-${promo?.status ?? 'none'}` : 'pass:not-found' };
        } catch (err) {
            return { redirect: null, reason: `pass:error:${headerSafe((err as Error).message)}` };
        }
    })();

    try {
        return await Promise.race([work, budget]);
    } finally {
        clearTimeout(timer);
    }
}
