/**
 * @jest-environment node
 *
 * FX1：/item/<id> 跳转判断（页面与中间件共用）。
 */
import { describe, it, expect, jest } from '@jest/globals';
import { lookupItemRedirectTraced, resolveItemRedirect, type ItemRedirectDeps } from '../item-redirect';
import type { ItemFetchResult, PromotionLookup } from '../item-data';

const OFFICIAL = 'd59f2q8ge0ap';
const TARGET = 'd59f2evs8ni8';
const DRAFT = '1j96hewiuieps';

function hit(entry: Record<string, unknown>): ItemFetchResult {
    return { entry, source: 'h1', version: 'h1:r1.json' };
}

function promo(p: PromotionLookup) {
    return jest.fn(async (_id: string) => p);
}

describe('resolveItemRedirect', () => {
    it('被并条目 → 308 到合并目标，不查升格表', async () => {
        const g = promo({ status: 'absent' });
        expect(await resolveItemRedirect(OFFICIAL, hit({ merged_into: TARGET }), g))
            .toEqual({ to: `/item/${TARGET}`, permanent: true });
        expect(await resolveItemRedirect(OFFICIAL, hit({ merged_into: { id: TARGET } }), g))
            .toEqual({ to: `/item/${TARGET}`, permanent: true });
        expect(g).not.toHaveBeenCalled();
    });

    it('正常条目、merged_into 指向自己或不合法 → 不跳', async () => {
        const g = promo({ status: 'absent' });
        expect(await resolveItemRedirect(OFFICIAL, hit({ title: 'x' }), g)).toBeNull();
        expect(await resolveItemRedirect(OFFICIAL, hit({ merged_into: OFFICIAL }), g)).toBeNull();
        expect(await resolveItemRedirect(OFFICIAL, hit({ merged_into: '../x' }), g)).toBeNull();
    });

    it('查不到的正式 id → 不跳（页面 404），不查升格表', async () => {
        const g = promo({ status: 'promoted', to: TARGET });
        expect(await resolveItemRedirect(OFFICIAL, null, g)).toBeNull();
        expect(g).not.toHaveBeenCalled();
    });

    it('查不到的草稿 id：升格 308／对照表没有则不跳／查不了 307 回 /book-index', async () => {
        expect(await resolveItemRedirect(DRAFT, null, promo({ status: 'promoted', to: 'hixhd2h9bk4b' })))
            .toEqual({ to: '/item/hixhd2h9bk4b', permanent: true });
        expect(await resolveItemRedirect(DRAFT, null, promo({ status: 'absent' }))).toBeNull();
        expect(await resolveItemRedirect(DRAFT, null, promo({ status: 'unknown' })))
            .toEqual({ to: `/book-index?id=${DRAFT}`, permanent: false });
    });
});

describe('lookupItemRedirectTraced（overview#491：升格对照表与条目并行，带原因）', () => {
    const PROMOTED = 'hixhd2h9bk4b';
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

    function deps(over: Partial<ItemRedirectDeps> = {}) {
        const getItem = jest.fn(async () => null as ItemFetchResult | null);
        const resolvePromotion = jest.fn(async (_id: string): Promise<PromotionLookup> => ({ status: 'promoted', to: PROMOTED }));
        return { getItem, resolvePromotion, ...over } as ItemRedirectDeps & { getItem: jest.Mock; resolvePromotion: jest.Mock };
    }

    it('已升格的草稿 id：条目只问 current/（currentOnly），升格 308，原因 redirect:promoted', async () => {
        const d = deps();
        const r = await lookupItemRedirectTraced(DRAFT, d, 1000);
        expect(r).toEqual({ redirect: { to: `/item/${PROMOTED}`, permanent: true }, reason: 'redirect:promoted' });
        expect(d.getItem).toHaveBeenCalledWith(DRAFT, { prefer: 'current', currentOnly: true });
        expect(d.resolvePromotion).toHaveBeenCalledTimes(1);
    });

    it('对照表与条目同时发出，不等条目查完才查对照表', async () => {
        const order: string[] = [];
        const d = deps({
            getItem: jest.fn(async () => { order.push('item:start'); await sleep(30); order.push('item:end'); return null; }),
            resolvePromotion: jest.fn(async () => { order.push('promo:start'); await sleep(5); order.push('promo:end'); return { status: 'promoted', to: PROMOTED } as PromotionLookup; }),
        });
        await lookupItemRedirectTraced(DRAFT, d, 1000);
        expect(order.slice(0, 2).sort()).toEqual(['item:start', 'promo:start']);
        expect(order.indexOf('promo:start')).toBeLessThan(order.indexOf('item:end'));
    });

    it('串行拖到超过预算时放行并说明各环节进度：pass:budget(...)', async () => {
        const d = deps({
            getItem: jest.fn(async () => { await sleep(80); return null; }),
            resolvePromotion: jest.fn(async () => ({ status: 'promoted', to: PROMOTED } as PromotionLookup)),
        });
        const r = await lookupItemRedirectTraced(DRAFT, d, 20);
        expect(r.redirect).toBeNull();
        expect(r.reason).toBe('pass:budget(20ms,entry=pending,promo=promoted)');
    });

    it('取条目抛错：放行，原因里带可见 ASCII 摘要', async () => {
        const d = deps({ getItem: jest.fn(async () => { throw new Error('latest.json HTTP 503 \u4e2d\u6587'); }) });
        const r = await lookupItemRedirectTraced(DRAFT, d, 1000);
        expect(r.redirect).toBeNull();
        expect(r.reason).toBe('pass:error:latest.json HTTP 503 ?');
    });

    it('对照表查不了 → 307 回 /book-index，原因 redirect:promo-unknown；对照表没有 → 放行 pass:promo-absent', async () => {
        expect(await lookupItemRedirectTraced(DRAFT, deps({ resolvePromotion: jest.fn(async () => ({ status: 'unknown' } as PromotionLookup)) }), 1000))
            .toEqual({ redirect: { to: `/book-index?id=${DRAFT}`, permanent: false }, reason: 'redirect:promo-unknown' });
        expect(await lookupItemRedirectTraced(DRAFT, deps({ resolvePromotion: jest.fn(async () => ({ status: 'absent' } as PromotionLookup)) }), 1000))
            .toEqual({ redirect: null, reason: 'pass:promo-absent' });
    });

    it('草稿条目本身存在（没升格）：放行 pass:entry-ok，对照表结果不用', async () => {
        const d = deps({ getItem: jest.fn(async () => hit({ id: DRAFT })), resolvePromotion: jest.fn(async () => ({ status: 'promoted', to: PROMOTED } as PromotionLookup)) });
        expect(await lookupItemRedirectTraced(DRAFT, d, 1000)).toEqual({ redirect: null, reason: 'pass:entry-ok' });
    });

    it('被并的正式条目：308 到目标，原因 redirect:merged，不查对照表', async () => {
        const d = deps({ getItem: jest.fn(async () => hit({ merged_into: TARGET })) });
        expect(await lookupItemRedirectTraced(OFFICIAL, d, 1000))
            .toEqual({ redirect: { to: `/item/${TARGET}`, permanent: true }, reason: 'redirect:merged' });
        expect(d.resolvePromotion).not.toHaveBeenCalled();
    });

    it('正式 id 的条目保留 h1 兜底（不传 currentOnly），防发布中途 current/ 与 h1 不一致时漏跳被并条目', async () => {
        const d = deps({ getItem: jest.fn(async () => hit({ merged_into: TARGET })) });
        await lookupItemRedirectTraced(OFFICIAL, d, 1000);
        expect(d.getItem).toHaveBeenCalledWith(OFFICIAL, { prefer: 'current' });
    });

    it('查不到的正式 id：放行 pass:not-found，不查对照表', async () => {
        const d = deps();
        expect(await lookupItemRedirectTraced(OFFICIAL, d, 1000)).toEqual({ redirect: null, reason: 'pass:not-found' });
        expect(d.resolvePromotion).not.toHaveBeenCalled();
    });
});
