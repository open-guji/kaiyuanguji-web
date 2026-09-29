/**
 * @jest-environment node
 *
 * W2-2 中间件：/book-index?id=<正式 id> → 308 /item/<id>，其余一律放过。
 * FX1：/item/<id> 的整页导航由中间件先跳（被并条目、草稿升格），只出一个 Location。
 * N5b：旧阅读入口 ?tab=fulltext／collated → 308 /read/<id>（overview#267 起阅读页在一级目录），保留卷号，站内请求也跳。
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

describe('middleware.ssr：/item/<id>?多余参数 → 308 干净地址（overview#280 S1）', () => {
    const ID = 'd59f2evs8ni8';
    const MERGED = 'd59f2q8ge0ap';
    const hit = (entry: Record<string, unknown>): ItemFetchResult => ({ entry, source: 'h1', version: 'h1:r' });

    beforeEach(() => {
        mockGetItem.mockReset();
        mockResolvePromotion.mockReset();
        mockGetItem.mockResolvedValue(hit({ title: '史記' }));
        jest.spyOn(console, 'warn').mockImplementation(() => {});
    });

    it('utm／fbclid／spm 等一律去掉，Location 只有一个值', async () => {
        for (const q of ['utm_source=x&utm_medium=y', 'fbclid=abc', 'spm=1.2.3', 'x=1&y=2', 'q=']) {
            const r = await run(`/item/${ID}?${q}`);
            expect({ q, status: r.status, all: r.all }).toEqual({ q, status: 308, all: [`https://staging.kaiyuanguji.com/item/${ID}`] });
        }
    });

    it('白名单里的参数保留（顺序、值不变），只去掉多余的', async () => {
        expect((await run(`/item/${ID}?utm_source=x&tab=lineage&fbclid=1&page=2`)).location)
            .toBe(`https://staging.kaiyuanguji.com/item/${ID}?tab=lineage&page=2`);
        expect((await run(`/item/${ID}?collection=abc&mode=graph&x=1`)).location)
            .toBe(`https://staging.kaiyuanguji.com/item/${ID}?collection=abc&mode=graph`);
    });

    it('只有白名单参数（或没有参数）→ 放过', async () => {
        for (const q of ['', '?tab=lineage', '?tab=lineage&page=2&mode=graph', '?redirected_from=1j96hewiuieps', '?no_redirect=true']) {
            const r = await run(`/item/${ID}${q}`);
            expect({ q, location: r.location }).toEqual({ q, location: null });
        }
    });

    it('被并条目带参数：一步 308 到目标（干净地址），不先去参数再跳一次', async () => {
        mockGetItem.mockResolvedValue(hit({ merged_into: ID }));
        const r = await run(`/item/${MERGED}?utm_source=x`);
        expect(r.all).toEqual([`https://staging.kaiyuanguji.com/item/${ID}`]);
    });

    it('取数出错也照跳（与数据无关）；RSC 导航与预取不动；不合法 id 不动', async () => {
        mockGetItem.mockRejectedValue(new Error('network down'));
        expect((await run(`/item/${ID}?utm_source=x`)).location).toBe(`https://staging.kaiyuanguji.com/item/${ID}`);
        expect((await run(`/item/${ID}?utm_source=x`, { 'sec-fetch-dest': 'empty' })).location).toBeNull();
        expect((await run('/item/BAD..id?utm_source=x')).location).toBeNull();
    });

    it('旧阅读入口 ?tab=fulltext 仍先按阅读入口跳，不被去参数抢走', async () => {
        mockGetItem.mockResolvedValue(hit({ has_text: true }));
        expect((await run(`/item/${ID}?tab=fulltext&utm_source=x`)).location).toContain(`/read/${ID}`);
    });
});

describe('middleware.ssr：旧阅读入口 → /read/<id>（N5b，overview#267 改一级目录）', () => {
    const ZHIZHAI = 'd59f2htm01du';
    const BOOK = '988fbiuha8';

    beforeEach(() => { mockGetItem.mockReset(); });

    it.each<[string, string]>([
        [`/book-index?tab=fulltext&id=${BOOK}&juan=003`, `/read/${BOOK}?kind=fulltext&juan=003`],
        [`/book-index?id=${ZHIZHAI}&tab=collated&juan=juan%2F011.json`, `/read/${ZHIZHAI}?kind=collated&juan=011`],
        [`/item/${ZHIZHAI}?tab=collated`, `/read/${ZHIZHAI}?kind=collated`],
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

    it('查得到条目才判断有没有这类内容；查不到、取数出错都照旧跳阅读页（由那边的页面判断）', async () => {
        mockGetItem.mockResolvedValueOnce(null);
        expect((await run(`/item/${ZHIZHAI}?tab=fulltext`)).all).toEqual([`https://staging.kaiyuanguji.com/read/${ZHIZHAI}?kind=fulltext`]);
        mockGetItem.mockRejectedValueOnce(new Error('HTTP 502'));
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        expect((await run(`/book-index?id=${ZHIZHAI}&tab=collated`)).all).toEqual([`https://staging.kaiyuanguji.com/read/${ZHIZHAI}?kind=collated`]);
        warn.mockRestore();
        expect(mockGetItem).toHaveBeenCalledTimes(2);
    });
});

/** overview#267 QA 回归 P2：条目没有这类内容，旧入口不再跳到只会 404 的阅读页 */
describe('middleware.ssr：旧阅读入口 · 条目没有这类内容 → 308 条目页', () => {
    const WORK = 'd59f2pra0vsw';
    const BOOK = '96kzkdm8e8';
    const hit = (entry: Record<string, unknown>): ItemFetchResult => ({ entry, source: 'h1', version: 'h1:r' });

    beforeEach(() => { mockGetItem.mockReset(); });

    it.each<[string, Record<string, unknown>, string, string]>([
        ['Work 没有整理本', { id: WORK, type: 'work', has_text: true }, `/book-index?id=${WORK}&tab=collated`, `/item/${WORK}`],
        ['Work 没有整理本（/item 入口，带卷号也丢掉）', { id: WORK, type: 'work' }, `/item/${WORK}?tab=collated&juan=juan%2F011.json`, `/item/${WORK}`],
        ['Work 没有全文', { id: WORK, type: 'work' }, `/book-index?id=${WORK}&tab=fulltext`, `/item/${WORK}`],
        ['Work 的标记不是 true（字符串、假）当作没有', { id: WORK, type: 'work', has_collated: 'true', has_text: false }, `/item/${WORK}?tab=fulltext`, `/item/${WORK}`],
        ['Book 没有全文', { id: BOOK, type: 'book' }, `/book-index?id=${BOOK}&tab=fulltext&juan=003`, `/item/${BOOK}`],
    ])('%s → 308 条目页', async (_n, entry, from, to) => {
        mockGetItem.mockResolvedValue(hit(entry));
        const r = await run(from);
        expect(r.status).toBe(308);
        expect(r.all).toEqual([`https://staging.kaiyuanguji.com${to}`]);
    });

    it.each<[string, Record<string, unknown>, string, string]>([
        ['Work 有整理本', { type: 'work', has_collated: true }, `/book-index?id=${WORK}&tab=collated&juan=juan%2F011.json`, `/read/${WORK}?kind=collated&juan=011`],
        ['Work 有全文（has_text）', { type: 'work', has_text: true }, `/item/${WORK}?tab=fulltext`, `/read/${WORK}?kind=fulltext`],
        ['Work 有全文（_has_text 同义）', { type: 'work', _has_text: true }, `/item/${WORK}?tab=fulltext`, `/read/${WORK}?kind=fulltext`],
        ['Book 有全文（has_full_text）', { type: 'book', has_full_text: true }, `/book-index?id=${BOOK}&tab=fulltext&juan=003`, `/read/${BOOK}?kind=fulltext&juan=003`],
    ])('%s → 照旧 308 阅读页', async (_n, entry, from, to) => {
        mockGetItem.mockResolvedValue(hit(entry));
        const r = await run(from);
        expect(r.status).toBe(308);
        expect(r.all).toEqual([`https://staging.kaiyuanguji.com${to}`]);
    });

    it('站内请求也一样判断', async () => {
        mockGetItem.mockResolvedValue(hit({ type: 'work' }));
        const r = await run(`/book-index?id=${WORK}&tab=collated`, { referer: `https://staging.kaiyuanguji.com/item/${WORK}`, 'sec-fetch-dest': 'empty' });
        expect(r.all).toEqual([`https://staging.kaiyuanguji.com/item/${WORK}`]);
    });
});

describe('middleware.ssr：阅读页搬到 /read/<id>（overview#267）', () => {
    const ZHIZHAI = 'd59f2htm01du';
    const BOOK = '988fbiuha8';

    beforeEach(() => { mockGetItem.mockReset(); });

    it.each<[string, string]>([
        // 上一版地址：路径换成 /read/<id>，查询参数原样带过去（含不认识的、顺序不变）
        [`/item/${ZHIZHAI}/read?kind=collated&juan=011`, `/read/${ZHIZHAI}?kind=collated&juan=011`],
        [`/item/${BOOK}/read?kind=fulltext&key=a&juan=001&x=1`, `/read/${BOOK}?kind=fulltext&key=a&juan=001&x=1`],
        [`/item/${ZHIZHAI}/read`, `/read/${ZHIZHAI}`],
        [`/item/${ZHIZHAI}/read/?kind=collated`, `/read/${ZHIZHAI}?kind=collated`],
        // 整理本的旧卷号同一跳里换成短形式，不先跳到 /read/<id> 再跳一次
        [`/item/${ZHIZHAI}/read?kind=collated&juan=juan%2F011.json`, `/read/${ZHIZHAI}?kind=collated&juan=011`],
        [`/item/${ZHIZHAI}/read?juan=juan%2F003.json`, `/read/${ZHIZHAI}?kind=collated&juan=003`],
        // 参数不合法的也照样搬过去，由新页面出真 404
        [`/item/${ZHIZHAI}/read?kind=nope&juan=x`, `/read/${ZHIZHAI}?kind=nope&juan=x`],
    ])('%s → 308 %s，只有一个 Location，站内请求也跳，不查数据', async (from, to) => {
        for (const headers of [{}, { 'sec-fetch-dest': 'empty', referer: 'https://staging.kaiyuanguji.com/' }] as Record<string, string>[]) {
            const r = await run(from, headers);
            expect(r.status).toBe(308);
            expect(r.all).toEqual([`https://staging.kaiyuanguji.com${to}`]);
        }
        expect(mockGetItem).not.toHaveBeenCalled();
    });

    it.each<[string, string]>([
        [`/read/${ZHIZHAI}?kind=collated&juan=juan%2F011.json`, `/read/${ZHIZHAI}?kind=collated&juan=011`],
        [`/read/${ZHIZHAI}?juan=juan%2F003.json`, `/read/${ZHIZHAI}?kind=collated&juan=003`],
    ])('新地址上的旧卷号 %s → 308 %s', async (from, to) => {
        const r = await run(from);
        expect(r.status).toBe(308);
        expect(r.all).toEqual([`https://staging.kaiyuanguji.com${to}`]);
    });

    it.each([
        `/read/${ZHIZHAI}?kind=collated&juan=011`, // 已是短形式
        `/read/${ZHIZHAI}?kind=collated`,
        `/read/${ZHIZHAI}`,
        `/read/${BOOK}?kind=fulltext&juan=juan%2F003.json`, // 全文不动，交给页面 404
        `/read/${ZHIZHAI}?kind=collated&juan=..%2F..%2Fx.json`, // 不是 juan/<名>.json，交给页面 404
        `/read/${ZHIZHAI}?kind=collated&juan=juan%2F..%2Fx.json`,
        `/read/${ZHIZHAI}?kind=nope&juan=juan%2F011.json`,
    ])('不跳：%s', async (from) => {
        const r = await run(from);
        expect(r.status).toBe(200);
        expect(r.location).toBeNull();
    });

    it.each([
        ['/read/assistant', '/read/md/assistant'],
        ['/read/assistant.md', '/read/md/assistant'],
        ['/read/roadmap_overview.md', '/read/md/roadmap_overview'],
        ['/read/typesetting?x=1', '/read/md/typesetting'],
    ])('旧的说明页地址 %s → 308 %s', async (from, to) => {
        const r = await run(from);
        expect(r.status).toBe(308);
        expect(r.all).toEqual([`https://staging.kaiyuanguji.com${to}`]);
    });

    it('说明页新地址、不是说明页的名字都不动', async () => {
        for (const path of ['/read/md/assistant', '/read/md', '/read/not-a-page']) {
            const r = await run(path);
            expect(r.status).toBe(200);
        }
    });
});
