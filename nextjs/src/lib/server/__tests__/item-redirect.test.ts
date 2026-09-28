/**
 * @jest-environment node
 *
 * FX1：/item/<id> 跳转判断（页面与中间件共用）。
 */
import { describe, it, expect, jest } from '@jest/globals';
import { resolveItemRedirect } from '../item-redirect';
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
