/**
 * @jest-environment node
 *
 * W2-2 中间件：/book-index?id=<正式 id> → 308 /item/<id>，其余一律放过。
 * FX1：/item/<id> 的整页导航由中间件先跳（被并条目、草稿升格），只出一个 Location。
 * N5b：旧阅读入口 ?tab=fulltext／collated → 308 /item/<id>/read，保留卷号，站内请求也跳。
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { NextRequest } from 'next/server';
import type { ItemFetchResult, PromotionLookup } from '../lib/server/item-data';

const mockGetItem = jest.fn<(id: string) => Promise<ItemFetchResult | null>>();
const mockResolvePromotion = jest.fn<(id: string) => Promise<PromotionLookup>>();

const mockCreateItemFetcher = jest.fn((_opts: Record<string, unknown>) => ({ getItem: mockGetItem, resolvePromotion: mockResolvePromotion }));

jest.mock('../lib/server/item-data', () => ({
    createItemFetcher: (opts: Record<string, unknown>) => mockCreateItemFetcher(opts),
    defaultItemDataBase: () => 'https://data.example.com',
}));

// jest.mock 与从 @jest/globals 引入的 jest 同用时不会被提升到 import 之前，中间件改为用到时再引
async function run(path: string, headers: Record<string, string> = {}) {
    const { middleware } = await import('../middleware.ssr');
    const res = await middleware(new NextRequest(`https://staging.kaiyuanguji.com${path}`, { headers }));
    return {
        status: res.status,
        location: res.headers.get('location'),
        all: res.headers.get('location')?.split(',') ?? [],
    };
}

describe('middleware.ssr：/book-index', () => {
    it('只有一个正式 id → 308 /item/<id>', async () => {
        const r = await run('/book-index?id=d59f20aowb9c');
        expect({ status: r.status, location: r.location }).toEqual({
            status: 308,
            location: 'https://staging.kaiyuanguji.com/item/d59f20aowb9c',
        });
    });
    it.each([
        '/book-index',
        '/book-index?id=d59f20aowb9c&tab=lineage', // 详情组件自己的 URL 同步，改写会丢 tab
        '/book-index?id=1evgpgqsis9hc', // 草稿 id：交给客户端查升格表
        '/book-index?id=1evgpgqsis9hc&redirected_from=x',
        '/book-index?id=bad..id',
        '/book-index?q=史記',
    ])('放过：%s', async (path) => {
        expect((await run(path)).location).toBeNull();
    });

    it('站外入口（无 Referer、或 Referer 是别的站）→ 308', async () => {
        expect((await run('/book-index?id=d59f20aowb9c', { referer: 'https://www.google.com/' })).status).toBe(308);
        expect((await run('/book-index?id=d59f20aowb9c', { 'sec-fetch-dest': 'document' })).status).toBe(308);
    });
    it.each<[Record<string, string>, string]>([
        [{ referer: 'https://staging.kaiyuanguji.com/item/988fbiuha8' }, '站内点击（面包屑等）'],
        [{ referer: 'https://staging.kaiyuanguji.com/book-index', 'sec-fetch-dest': 'empty' }, 'RSC 预取'],
        [{ 'sec-fetch-dest': 'empty' }, '非整页请求'],
    ])('站内请求放过：%j（%s）', async (headers) => {
        expect((await run('/book-index?id=d59f20aowb9c', headers)).location).toBeNull();
    });
});

describe('middleware.ssr：/item/<id>（FX1）', () => {
    const MERGED = 'd59f2q8ge0ap';
    const TARGET = 'd59f2evs8ni8';
    const DRAFT = '1j96hewiuieps';
    const hit = (entry: Record<string, unknown>): ItemFetchResult => ({ entry, source: 'h1', version: 'h1:r' });

    beforeEach(() => {
        mockGetItem.mockReset();
        mockResolvePromotion.mockReset();
        jest.spyOn(console, 'warn').mockImplementation(() => {});
    });

    it('被并条目 → 308，Location 只有一个值', async () => {
        mockGetItem.mockResolvedValue(hit({ merged_into: TARGET }));
        const r = await run(`/item/${MERGED}`);
        expect(r.status).toBe(308);
        expect(r.all).toEqual([`https://staging.kaiyuanguji.com/item/${TARGET}`]);
        expect((await run(`/item/${MERGED}`, { 'sec-fetch-dest': 'document', referer: 'https://staging.kaiyuanguji.com/' })).status).toBe(308);
    });

    it('已升格的草稿 id → 308 正式 id；对照表查不了 → 307 /book-index', async () => {
        mockGetItem.mockResolvedValue(null);
        mockResolvePromotion.mockResolvedValue({ status: 'promoted', to: 'hixhd2h9bk4b' });
        expect(await run(`/item/${DRAFT}`)).toMatchObject({ status: 308, location: 'https://staging.kaiyuanguji.com/item/hixhd2h9bk4b' });
        mockResolvePromotion.mockResolvedValue({ status: 'unknown' });
        expect(await run(`/item/${DRAFT}`)).toMatchObject({ status: 307, location: `https://staging.kaiyuanguji.com/book-index?id=${DRAFT}` });
    });

    it.each<[string, () => void]>([
        ['正常条目', () => mockGetItem.mockResolvedValue(hit({ title: '史記' }))],
        ['查不到的正式 id（页面 404）', () => mockGetItem.mockResolvedValue(null)],
        ['草稿 id 对照表确定没有（页面 404）', () => { mockGetItem.mockResolvedValue(null); mockResolvePromotion.mockResolvedValue({ status: 'absent' }); }],
        ['取数出错（交给页面）', () => mockGetItem.mockRejectedValue(new Error('network down'))],
    ])('放过：%s', async (_name, setup) => {
        setup();
        const id = _name.startsWith('草稿') ? DRAFT : MERGED;
        const r = await run(`/item/${id}`);
        expect(r.location).toBeNull();
        expect(r.status).toBe(200);
    });

    it('RSC 导航与预取（sec-fetch-dest 不是 document）不查数据、直接放过', async () => {
        mockGetItem.mockResolvedValue(hit({ merged_into: TARGET }));
        expect((await run(`/item/${MERGED}`, { 'sec-fetch-dest': 'empty' })).location).toBeNull();
        expect(mockGetItem).not.toHaveBeenCalled();
    });

    it('建取数实例时传 forceCache: false（边缘运行时不认 force-cache）', async () => {
        mockGetItem.mockResolvedValue(hit({ title: '史記' }));
        await run(`/item/${MERGED}`);
        expect(mockCreateItemFetcher).toHaveBeenCalledWith(expect.objectContaining({ forceCache: false }));
    });

    it('不合法的 id 不查数据', async () => {
        expect((await run('/item/BAD..id')).location).toBeNull();
        expect(mockGetItem).not.toHaveBeenCalled();
    });
});

describe('middleware.ssr：旧阅读入口 → /item/<id>/read（N5b）', () => {
    const ZHIZHAI = 'd59f2htm01du';
    const BOOK = '988fbiuha8';

    beforeEach(() => { mockGetItem.mockReset(); });

    it.each<[string, string]>([
        [`/book-index?tab=fulltext&id=${BOOK}&juan=003`, `/item/${BOOK}/read?kind=fulltext&juan=003`],
        [`/book-index?id=${ZHIZHAI}&tab=collated&juan=juan%2F011.json`, `/item/${ZHIZHAI}/read?kind=collated&juan=juan%2F011.json`],
        [`/item/${ZHIZHAI}?tab=collated`, `/item/${ZHIZHAI}/read?kind=collated`],
    ])('%s → 308 %s', async (from, to) => {
        const r = await run(from);
        expect(r.status).toBe(308);
        expect(r.all).toEqual([`https://staging.kaiyuanguji.com${to}`]);
    });

    it('站内点击与 RSC 导航也跳（条目页的 tab 仍往 /book-index 推）', async () => {
        const inSite = { referer: `https://staging.kaiyuanguji.com/item/${ZHIZHAI}`, 'sec-fetch-dest': 'empty' };
        expect((await run(`/book-index?id=${ZHIZHAI}&tab=collated`, inSite)).status).toBe(308);
        expect((await run(`/item/${ZHIZHAI}?tab=collated`, inSite)).status).toBe(308);
    });

    it('/item/<id>?tab= 不查数据', async () => {
        await run(`/item/${ZHIZHAI}?tab=fulltext`);
        expect(mockGetItem).not.toHaveBeenCalled();
    });
});
