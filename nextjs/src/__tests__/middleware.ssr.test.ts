/**
 * @jest-environment node
 *
 * W2-2 中间件：/book-index?id=<正式 id> → 308 /item/<id>，其余一律放过。
 * FX1：/item/<id> 的整页导航由中间件先跳（被并条目、草稿升格），只出一个 Location。
 * N5b／overview#307 E 块：旧阅读入口（?tab=、/item/<id>/read、/read/<id>?kind=…）→ 308 新路径式地址（版本与章号按该条目的 manifest 换算），站内请求也跳。
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { NextRequest } from 'next/server';
import type { ItemFetchResult, PromotionLookup } from '../lib/server/item-data';

const mockGetItem = jest.fn<(id: string) => Promise<ItemFetchResult | null>>();
const mockResolvePromotion = jest.fn<(id: string) => Promise<PromotionLookup>>();
/** current/ 下的 JSON（阅读页旧地址换算要读 items/<id>/manifest.json） */
const mockGetCurrentJson = jest.fn<(rel: string) => Promise<unknown>>();

const mockCreateItemFetcher = jest.fn((_opts: Record<string, unknown>) => ({ getItem: mockGetItem, resolvePromotion: mockResolvePromotion, getCurrentJson: mockGetCurrentJson }));

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
        reason: res.headers.get('x-kyg-item-redirect'),
        cacheControl: res.headers.get('cache-control'),
        edgeCache: res.headers.get('eo-cdn-cache-control'),
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
        expect(mockCreateItemFetcher).toHaveBeenCalledWith(expect.objectContaining({ forceCache: false, retries: 0 }));
    });

    it("取条目先走 current/（overview#322 B1）；草稿 id 只问 current/（#491：边缘上不再白串 h1 的 3 跳）", async () => {
        mockGetItem.mockResolvedValue(hit({ title: '史記' }));
        await run(`/item/${MERGED}`);
        expect(mockGetItem).toHaveBeenCalledWith(MERGED, { prefer: 'current' });
        mockGetItem.mockClear();
        mockGetItem.mockResolvedValue(null);
        mockResolvePromotion.mockResolvedValue({ status: 'absent' });
        await run('/item/1j96hewiuieps');
        expect(mockGetItem).toHaveBeenCalledWith('1j96hewiuieps', { prefer: 'current', currentOnly: true });
    });

    it('已升格的草稿 id：308 只有一个 Location，响应头 x-kyg-item-redirect 说明是升格跳转（overview#491）', async () => {
        mockGetItem.mockResolvedValue(null);
        mockResolvePromotion.mockResolvedValue({ status: 'promoted', to: 'hixhd2h9bk4b' });
        const r = await run('/item/1j96hewiuieps', { 'sec-fetch-dest': 'document' });
        expect({ status: r.status, all: r.all, reason: r.reason }).toEqual({
            status: 308,
            all: ['https://staging.kaiyuanguji.com/item/hixhd2h9bk4b'],
            reason: 'redirect:promoted',
        });
    });

    it('没跳的 /item 响应也带原因头（正式 id 取条目抛错 → pass:error，交给页面）', async () => {
        mockGetItem.mockRejectedValue(new Error('latest.json HTTP 503'));
        const r = await run(`/item/${MERGED}`, { 'sec-fetch-dest': 'document' });
        expect(r.location).toBeNull();
        expect(r.reason).toBe('pass:error:latest.json HTTP 503');
    });

    it('正式 id 的跳转判断超过时限（3s）→ 放过交给页面，不挂着等', async () => {
        jest.useFakeTimers();
        try {
            mockGetItem.mockImplementation(() => new Promise(() => {}));
            const pending = run(`/item/${MERGED}`);
            await jest.advanceTimersByTimeAsync(2_999);
            let done = false;
            void pending.then(() => { done = true; });
            await jest.advanceTimersByTimeAsync(0);
            expect(done).toBe(false);
            await jest.advanceTimersByTimeAsync(1);
            const r = await pending;
            expect(r.location).toBeNull();
            expect(r.status).toBe(200);
            expect(r.reason).toMatch(/^pass:budget\(3000ms/);
        } finally {
            jest.useRealTimers();
        }
    });

    it('草稿 id 超时没有定论 → 不放给页面（会出双 Location 并被 CDN 缓存），改出不缓存的 307 到 /book-index?id=', async () => {
        jest.useFakeTimers();
        try {
            mockGetItem.mockImplementation(() => new Promise(() => {}));
            mockResolvePromotion.mockImplementation(() => new Promise(() => {}));
            const pending = run('/item/1j96hewiuieps', { 'sec-fetch-dest': 'document' });
            await jest.advanceTimersByTimeAsync(3_000);
            const r = await pending;
            expect(r.status).toBe(307);
            expect(r.all).toEqual(['https://staging.kaiyuanguji.com/book-index?id=1j96hewiuieps']);
            expect(r.cacheControl).toBe('no-store');
            expect(r.edgeCache).toBe('no-store');
            expect(r.reason).toBe('pass:budget(3000ms,entry=pending,promo=pending);fallback:307');
        } finally {
            jest.useRealTimers();
        }
    });

    it('草稿 id 取条目出错、对照表也没答 → 同样临时 307', async () => {
        mockGetItem.mockRejectedValue(new Error('latest.json HTTP 503'));
        mockResolvePromotion.mockResolvedValue({ status: 'unknown' });
        const r = await run('/item/1j96hewiuieps', { 'sec-fetch-dest': 'document' });
        // 取条目抛错 → pass:error → 草稿 id 的临时 307（对照表 unknown 时页面兜底同样是 307 回 /book-index）
        expect(r.reason).toBe('pass:error:latest.json HTTP 503;fallback:307');
        expect(r.status).toBe(307);
        expect(r.all).toEqual(['https://staging.kaiyuanguji.com/book-index?id=1j96hewiuieps']);
        expect(r.cacheControl).toBe('no-store');
    });

    it('永久 308（升格、被并）不加 no-store', async () => {
        mockGetItem.mockResolvedValue(null);
        mockResolvePromotion.mockResolvedValue({ status: 'promoted', to: 'hixhd2h9bk4b' });
        const r = await run('/item/1j96hewiuieps', { 'sec-fetch-dest': 'document' });
        expect(r.status).toBe(308);
        expect(r.cacheControl).toBeNull();
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
        mockGetCurrentJson.mockResolvedValue({ versions: [{ key: 'default', kind: 'transcription', source: 'wikisource' }] });
        expect((await run(`/item/${ID}?tab=fulltext&utm_source=x`)).location).toContain(`/read/${ID}`);
    });
});

const manifest = (...v: [key: string, kind: string, source: string][]) => ({ id: 'x', versions: v.map(([key, kind, source]) => ({ key, kind, source })) });
const COLLATED_DEFAULT = manifest(['default', 'collated', 'collated'], ['wikisource', 'transcription', 'wikisource'], ['kanripo', 'transcription', 'kanripo']);
const WIKI_DEFAULT = manifest(['default', 'transcription', 'wikisource'], ['kanripo', 'transcription', 'kanripo']);
const SITE = 'https://staging.kaiyuanguji.com';

describe('middleware.ssr：旧阅读入口 → 新路径式地址（N5b；overview#307 E 块）', () => {
    const ZHIZHAI = 'd59f2htm01du';
    const BOOK = '988fbiuha8';

    beforeEach(() => {
        mockGetItem.mockReset();
        mockGetCurrentJson.mockReset();
    });

    it.each<[string, ReturnType<typeof manifest>, string]>([
        // 条目页页签：章号补成三位，版本按 manifest
        [`/book-index?tab=fulltext&id=${BOOK}&juan=003`, manifest(['default', 'transcription', 'wikisource']), `/read/${BOOK}/003`],
        [`/book-index?id=${ZHIZHAI}&tab=collated&juan=juan%2F011.json`, COLLATED_DEFAULT, `/read/${ZHIZHAI}/011`],
        [`/item/${ZHIZHAI}?tab=collated`, COLLATED_DEFAULT, `/read/${ZHIZHAI}`],
        // 整理本是 default、维基是另一份：旧的全文 tab 进 /wikisource
        [`/item/${ZHIZHAI}?tab=fulltext&juan=2`, COLLATED_DEFAULT, `/read/${ZHIZHAI}/wikisource/002`],
        [`/item/${ZHIZHAI}?tab=fulltext`, WIKI_DEFAULT, `/read/${ZHIZHAI}`],
    ])('%s → 308 %s', async (from, m, to) => {
        mockGetCurrentJson.mockResolvedValue(m);
        const r = await run(from);
        expect(r.status).toBe(308);
        expect(r.all).toEqual([`${SITE}${to}`]);
        expect(mockGetCurrentJson).toHaveBeenCalledWith(`items/${from.includes('id=') ? from.match(/id=([0-9a-z]+)/)![1] : from.match(/\/item\/([0-9a-z]+)/)![1]}/manifest.json`);
    });

    it('站内点击与 RSC 导航也跳（条目页的 tab 仍往 /book-index 推）', async () => {
        mockGetCurrentJson.mockResolvedValue(COLLATED_DEFAULT);
        const inSite = { referer: `${SITE}/item/${ZHIZHAI}`, 'sec-fetch-dest': 'empty' };
        expect((await run(`/book-index?id=${ZHIZHAI}&tab=collated`, inSite)).status).toBe(308);
        expect((await run(`/item/${ZHIZHAI}?tab=collated`, inSite)).status).toBe(308);
    });

    it('条目没有文本（没有 manifest）→ 308 条目页，不跳只会 404 的阅读页；站内请求也一样', async () => {
        mockGetCurrentJson.mockResolvedValue(null);
        expect((await run(`/item/${ZHIZHAI}?tab=fulltext`)).all).toEqual([`${SITE}/item/${ZHIZHAI}`]);
        expect((await run(`/book-index?id=${BOOK}&tab=fulltext&juan=003`)).all).toEqual([`${SITE}/item/${BOOK}`]);
        const inSite = { referer: `${SITE}/item/${ZHIZHAI}`, 'sec-fetch-dest': 'empty' };
        expect((await run(`/book-index?id=${ZHIZHAI}&tab=collated`, inSite)).all).toEqual([`${SITE}/item/${ZHIZHAI}`]);
    });

    it('取数出错：不替页面下结论，放过（交给页面）', async () => {
        mockGetCurrentJson.mockRejectedValue(new Error('HTTP 502'));
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        const r = await run(`/book-index?id=${ZHIZHAI}&tab=collated`);
        expect(r.location).toBeNull();
        warn.mockRestore();
    });

    it('条目类型没有阅读页（人物）、别的 tab、升格横幅往返：不动', async () => {
        for (const path of ['/book-index?id=hixhd2h9bk4b&tab=fulltext', `/item/${ZHIZHAI}?tab=lineage`, `/item/${ZHIZHAI}?tab=fulltext&redirected_from=x`]) {
            expect((await run(path)).status).toBe(200);
        }
        expect(mockGetCurrentJson).not.toHaveBeenCalled();
    });
});

describe('middleware.ssr：阅读页地址（overview#267／#307）', () => {
    const ZHIZHAI = 'd59f2htm01du';
    const BOOK = '988fbiuha8';

    beforeEach(() => {
        mockGetItem.mockReset();
        mockGetCurrentJson.mockReset();
    });

    it.each<[string, ReturnType<typeof manifest>, string]>([
        // 上一版地址 /item/<id>/read?…：旧查询串按 manifest 换算成新路径（其余参数丢掉）
        [`/item/${ZHIZHAI}/read?kind=collated&juan=011`, COLLATED_DEFAULT, `/read/${ZHIZHAI}/011`],
        [`/item/${BOOK}/read?kind=fulltext&key=wikisource-01&juan=001&x=1`, WIKI_DEFAULT, `/read/${BOOK}/001`],
        [`/item/${ZHIZHAI}/read/?kind=fulltext&key=wikisource-01&juan=1`, COLLATED_DEFAULT, `/read/${ZHIZHAI}/wikisource/001`],
        [`/item/${ZHIZHAI}/read?kind=collated&juan=juan%2F011.json`, COLLATED_DEFAULT, `/read/${ZHIZHAI}/011`],
        [`/item/${ZHIZHAI}/read?juan=juan%2F003.json`, COLLATED_DEFAULT, `/read/${ZHIZHAI}/003`],
        // 这一版（/read/<id>?kind=…）的查询串形式
        [`/read/${ZHIZHAI}?kind=fulltext&key=kanripo-01&juan=12`, COLLATED_DEFAULT, `/read/${ZHIZHAI}/kanripo/012`],
        [`/read/${ZHIZHAI}?kind=collated`, COLLATED_DEFAULT, `/read/${ZHIZHAI}`],
    ])('%s → 308 %s，只有一个 Location，站内请求也跳', async (from, m, to) => {
        mockGetCurrentJson.mockResolvedValue(m);
        for (const headers of [{}, { 'sec-fetch-dest': 'empty', referer: `${SITE}/` }] as Record<string, string>[]) {
            const r = await run(from, headers);
            expect(r.status).toBe(308);
            expect(r.all).toEqual([`${SITE}${to}`]);
        }
    });

    it('/item/<id>/read 没带旧参数：/read/<id>，不查数据；带了旧参数但条目没有文本：条目页', async () => {
        const r = await run(`/item/${ZHIZHAI}/read`);
        expect(r.all).toEqual([`${SITE}/read/${ZHIZHAI}`]);
        expect(mockGetCurrentJson).not.toHaveBeenCalled();
        mockGetCurrentJson.mockResolvedValue(null);
        expect((await run(`/item/${ZHIZHAI}/read?kind=collated&juan=011`)).all).toEqual([`${SITE}/item/${ZHIZHAI}`]);
    });

    it.each<[string, string]>([
        [`/read/${ZHIZHAI}/default`, `/read/${ZHIZHAI}`],
        [`/read/${ZHIZHAI}/default/003`, `/read/${ZHIZHAI}/003`],
        [`/read/${BOOK}/default/`, `/read/${BOOK}`],
    ])('主版本地址里写了 default：%s → 308 %s（只换算字符串，不查数据）', async (from, to) => {
        const r = await run(from);
        expect(r.status).toBe(308);
        expect(r.all).toEqual([`${SITE}${to}`]);
        expect(mockGetCurrentJson).not.toHaveBeenCalled();
    });

    it.each([
        `/read/${ZHIZHAI}`,
        `/read/${ZHIZHAI}/003`,
        `/read/${ZHIZHAI}/wikisource`,
        `/read/${ZHIZHAI}/wikisource-2/003`,
        `/read/${ZHIZHAI}/Bad_Key`, // 形态不对：交给页面出真 404
        `/read/${ZHIZHAI}/a/b/c`,
        `/read/${ZHIZHAI}?utm_source=x`, // 没有旧的 kind／key／juan
    ])('不跳：%s', async (from) => {
        const r = await run(from);
        expect(r.status).toBe(200);
        expect(r.location).toBeNull();
        expect(mockGetCurrentJson).not.toHaveBeenCalled();
    });

    it('/read/<id>?kind=… 但取 manifest 出错：307 条目页（阅读页是 ISR、不读查询串，不能交给页面，overview#322）', async () => {
        jest.spyOn(console, 'warn').mockImplementation(() => {});
        mockGetCurrentJson.mockRejectedValue(new Error('cos down'));
        const r = await run(`/read/${ZHIZHAI}?kind=collated&juan=011`);
        expect(r.status).toBe(307);
        expect(r.all).toEqual([`${SITE}/item/${ZHIZHAI}`]);
    });

    it('被并条目的阅读页：整页导航 308 到目标的阅读页（同版本、同章），只有一个 Location（overview#322）', async () => {
        const TARGET = 'd59f2evs8ni8';
        mockGetItem.mockResolvedValue({ entry: { merged_into: TARGET }, source: 'h1', version: 'h1:r' });
        const r = await run(`/read/${ZHIZHAI}/wikisource/003`);
        expect(r.status).toBe(308);
        expect(r.all).toEqual([`${SITE}/read/${TARGET}/wikisource/003`]);
        // RSC 导航与预取不查数据，交给页面
        mockGetItem.mockClear();
        expect((await run(`/read/${ZHIZHAI}`, { 'sec-fetch-dest': 'empty' })).location).toBeNull();
        expect(mockGetItem).not.toHaveBeenCalled();
    });

    it('阅读页的条目取数出错：放过交给页面', async () => {
        jest.spyOn(console, 'warn').mockImplementation(() => {});
        mockGetItem.mockRejectedValue(new Error('network down'));
        const r = await run(`/read/${ZHIZHAI}/003`);
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
        expect(r.all).toEqual([`${SITE}${to}`]);
    });

    it('说明页新地址、不是说明页的名字都不动', async () => {
        for (const path of ['/read/md/assistant', '/read/md', '/read/not-a-page']) {
            const r = await run(path);
            expect(r.status).toBe(200);
        }
    });
});
