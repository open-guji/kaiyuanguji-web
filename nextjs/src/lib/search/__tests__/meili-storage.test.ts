/**
 * meili-storage 单测：L1 success / L1 fail → L2 fallback / circuit breaker
 *
 * 验证 fallback 协议工作正常 — 这是 hybrid 架构的核心保障。
 */
import { jest } from '@jest/globals';

// 关键：测试组之间 breaker 状态会污染（模块级单例）。每个测试都用
// jest.isolateModules 拿一份新的 wrap，避免测试顺序依赖。
function freshModule() {
    let mod: any;
    jest.isolateModules(() => {
        mod = require('../meili-storage');
    });
    return mod;
}
import type { IndexStorage } from 'book-index-ui/storage';

function makeBase(overrides: Partial<IndexStorage> = {}): IndexStorage {
    return {
        loadEntries: jest.fn(),
        search: jest.fn().mockResolvedValue({ entries: [], total: 0, page: 1, pageSize: 50 }),
        searchAll: jest.fn().mockResolvedValue({
            works: [], books: [], collections: [], entities: [],
            totalWorks: 0, totalBooks: 0, totalCollections: 0, totalEntities: 0,
        }),
        getItem: jest.fn().mockResolvedValue(null),
        saveItem: jest.fn(),
        deleteItem: jest.fn(),
        generateId: jest.fn(),
        ...overrides,
    } as unknown as IndexStorage;
}

describe('meili-storage HybridTransport', () => {
    let originalFetch: typeof fetch;
    beforeEach(() => {
        originalFetch = global.fetch;
    });
    afterEach(() => {
        global.fetch = originalFetch;
        jest.clearAllMocks();
    });

    it('L1 成功时返回 Meili 结果，不调用 base.searchAll', async () => {
        global.fetch = jest.fn().mockResolvedValue({
            ok: true,
            json: async () => ({
                hits: [{ id: 'w1', type: 'work', title: '史记', author: '司马迁', completeness: 16 }],
                estimatedTotalHits: 1,
                processingTimeMs: 2,
            }),
        }) as any;

        const base = makeBase();
        const { wrapWithMeiliSearch } = freshModule();
        const wrapped = wrapWithMeiliSearch(base, { baseUrl: 'http://test' });
        const r = await wrapped.searchAll!('史记', 5);

        expect(base.searchAll).not.toHaveBeenCalled();
        // 4 个 index 并行 fetch
        expect(global.fetch).toHaveBeenCalledTimes(4);
        expect(r.works).toHaveLength(1);
        expect(r.works[0]).toMatchObject({ id: 'w1', title: '史记' });
    });

    it('单次 L1 失败返回空结果，不立即透传 L2（避免触发 8 MB worker shard 下载）', async () => {
        global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 500, text: async () => 'oops' }) as any;
        const base = makeBase();
        const { wrapWithMeiliSearch } = freshModule();
        const wrapped = wrapWithMeiliSearch(base, { baseUrl: 'http://test' });
        const r = await wrapped.searchAll!('史记', 5);

        expect(base.searchAll).not.toHaveBeenCalled();
        expect(r.works).toEqual([]);
        expect(r.totalWorks).toBe(0);
    });

    it('单次 L1 网络错误也只返回空，不立即触发 worker', async () => {
        global.fetch = jest.fn().mockRejectedValue(new Error('network')) as any;
        const base = makeBase();
        const { wrapWithMeiliSearch } = freshModule();
        const wrapped = wrapWithMeiliSearch(base, { baseUrl: 'http://test' });
        const r = await wrapped.searchAll!('q', 5);
        expect(base.searchAll).not.toHaveBeenCalled();
        expect(r.works).toEqual([]);
    });

    it('401 鉴权失败（key 缺失/失效）→ 第一次就熔断并透传 L2', async () => {
        global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 401, text: async () => '' }) as any;
        const base = makeBase({
            searchAll: jest.fn().mockResolvedValue({
                works: [{ id: 'l2', type: 'work', title: 'l2-fallback', isDraft: true }],
                books: [], collections: [], entities: [],
                totalWorks: 1, totalBooks: 0, totalCollections: 0, totalEntities: 0,
            }),
        });
        const { wrapWithMeiliSearch } = freshModule();
        const wrapped = wrapWithMeiliSearch(base, { baseUrl: 'http://test' });

        // 配置类故障不会自愈：首次失败就应 fallback，而不是让用户看到空结果
        const r = await wrapped.searchAll!('q', 5);
        expect(base.searchAll).toHaveBeenCalled();
        expect(r.works[0].title).toBe('l2-fallback');

        // breaker 已 open：后续搜索直接走 L2，不再打 L1
        (global.fetch as jest.Mock).mockClear();
        await wrapped.searchAll!('q', 5);
        expect(global.fetch).not.toHaveBeenCalled();
    });

    it('连续失败累积到阈值后 breaker open → fallback 启用（持续故障模式）', async () => {
        global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 502, text: async () => '' }) as any;
        const base = makeBase({
            searchAll: jest.fn().mockResolvedValue({
                works: [{ id: 'l2', type: 'work', title: 'l2-fallback', isDraft: true }],
                books: [], collections: [], entities: [],
                totalWorks: 1, totalBooks: 0, totalCollections: 0, totalEntities: 0,
            }),
        });
        const { wrapWithMeiliSearch } = freshModule();
        const wrapped = wrapWithMeiliSearch(base, { baseUrl: 'http://test' });

        // breaker 阈值 3：前 2 次失败不 fallback，从第 3 次失败起进入 fallback
        await wrapped.searchAll!('q', 5);
        await wrapped.searchAll!('q', 5);
        expect(base.searchAll).not.toHaveBeenCalled();

        const r = await wrapped.searchAll!('q', 5);
        expect(base.searchAll).toHaveBeenCalled();
        expect(r.works[0].title).toBe('l2-fallback');
    });

    it('空 query 立即返回空，不调 L1 也不调 L2', async () => {
        global.fetch = jest.fn() as any;
        const base = makeBase();
        const { wrapWithMeiliSearch } = freshModule();
        const wrapped = wrapWithMeiliSearch(base, { baseUrl: 'http://test' });
        const r = await wrapped.searchAll!('  ', 5);
        expect(global.fetch).not.toHaveBeenCalled();
        expect(base.searchAll).not.toHaveBeenCalled();
        expect(r.works).toEqual([]);
        expect(r.totalWorks).toBe(0);
    });

    it('search(type) 单次 L1 失败 fallback 到 base.search（翻页路径，触发 worker 可接受）', async () => {
        global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 503, text: async () => '' }) as any;
        const base = makeBase({
            search: jest.fn().mockResolvedValue({
                entries: [{ id: 'fb', type: 'work', title: 'l2', isDraft: true }],
                total: 1, page: 1, pageSize: 50,
            }),
        });
        const { wrapWithMeiliSearch } = freshModule();
        const wrapped = wrapWithMeiliSearch(base, { baseUrl: 'http://test' });
        const r = await wrapped.search('q', 'work', { page: 1, pageSize: 50 });
        expect(base.search).toHaveBeenCalled();
        expect(r.entries[0].title).toBe('l2');
    });

    it('searchAll 部分分类失败时保留成功的部分', async () => {
        // works 成功（含 1 条结果），books 失败（HTTP 503），collections/entities 成功但空
        let callCount = 0;
        global.fetch = jest.fn().mockImplementation((url: string) => {
            callCount++;
            if (url.includes('/books/')) {
                return Promise.resolve({ ok: false, status: 503, text: async () => '' });
            }
            const hits = url.includes('/works/')
                ? [{ id: 'w1', type: 'work', title: '汉书', author: '班固' }]
                : [];
            return Promise.resolve({ ok: true, json: async () => ({ hits, estimatedTotalHits: hits.length, processingTimeMs: 1 }) });
        }) as any;
        const base = makeBase();
        const { wrapWithMeiliSearch } = freshModule();
        const wrapped = wrapWithMeiliSearch(base, { baseUrl: 'http://test' });
        const r = await wrapped.searchAll!('汉书', 5);

        // 没有进 fallback
        expect(base.searchAll).not.toHaveBeenCalled();
        // works 成功的结果保留
        expect(r.works).toHaveLength(1);
        expect(r.works[0].id).toBe('w1');
        // books 失败 → 该分类显示空（不是搜索整体失败）
        expect(r.books).toEqual([]);
        expect(r.totalBooks).toBe(0);
    });

    it('Proxy 透传非搜索方法到 base — getEntry/getCounts 等不被劫持', async () => {
        global.fetch = jest.fn() as any;
        const getCounts = jest.fn().mockResolvedValue({ works: 100, books: 0, collections: 0, entities: 0,
            resourceCounts: { hasText: 0, hasImage: 0 }, subtypeStats: {} });
        const base = makeBase({ getCounts } as any);
        const { wrapWithMeiliSearch } = freshModule();
        const wrapped = wrapWithMeiliSearch(base, { baseUrl: 'http://test' });
        const r = await (wrapped as any).getCounts();
        expect(global.fetch).not.toHaveBeenCalled();
        expect(getCounts).toHaveBeenCalled();
        expect(r.works).toBe(100);
    });

    it('简介命中时 descriptionSnippet 取自 _formatted.description_search（A4）', async () => {
        const { SNIPPET_MARK_START, SNIPPET_MARK_END } = require('book-index-ui');
        global.fetch = jest.fn().mockImplementation((url: string) => {
            const hit = url.includes('/works/')
                ? {
                    id: 'w1', type: 'work', title: '紅樓夢稿',
                    _formatted: { description_search: `原為咸豐間${SNIPPET_MARK_START}楊繼振${SNIPPET_MARK_END}所藏` },
                }
                : null;
            const hits = hit ? [hit] : [];
            return Promise.resolve({ ok: true, json: async () => ({ hits, estimatedTotalHits: hits.length, processingTimeMs: 1 }) });
        }) as any;
        const base = makeBase();
        const { wrapWithMeiliSearch } = freshModule();
        const wrapped = wrapWithMeiliSearch(base, { baseUrl: 'http://test' });
        const r = await wrapped.searchAll!('楊繼振', 5);

        expect(r.works[0].descriptionSnippet).toBe(`原為咸豐間${SNIPPET_MARK_START}楊繼振${SNIPPET_MARK_END}所藏`);
    });

    it('简介未命中（_formatted 里没有高亮标记）时不展示无关片段', async () => {
        global.fetch = jest.fn().mockResolvedValue({
            ok: true,
            json: async () => ({
                // 有 _formatted 但里面没有 sentinel——说明查询命中的是 title，不是简介，
                // 这段是从头裁出来的无关文字，不该被当成"命中简介"展示
                hits: [{ id: 'w1', type: 'work', title: '史记', _formatted: { description_search: '西汉史学家司马迁所著' } }],
                estimatedTotalHits: 1,
                processingTimeMs: 1,
            }),
        }) as any;
        const base = makeBase();
        const { wrapWithMeiliSearch } = freshModule();
        const wrapped = wrapWithMeiliSearch(base, { baseUrl: 'http://test' });
        const r = await wrapped.searchAll!('史记', 5);

        expect(r.works[0].descriptionSnippet).toBeUndefined();
    });

    it('只对 works/books 请求简介高亮参数，collections/entities 不带（省流量、也没这个字段）', async () => {
        const calledUrls: string[] = [];
        global.fetch = jest.fn().mockImplementation((url: string) => {
            calledUrls.push(url);
            return Promise.resolve({ ok: true, json: async () => ({ hits: [], estimatedTotalHits: 0, processingTimeMs: 0 }) });
        }) as any;
        const base = makeBase();
        const { wrapWithMeiliSearch } = freshModule();
        const wrapped = wrapWithMeiliSearch(base, { baseUrl: 'http://test' });
        await wrapped.searchAll!('q', 5);

        const worksUrl = calledUrls.find(u => u.includes('/works/'));
        const booksUrl = calledUrls.find(u => u.includes('/books/'));
        const collectionsUrl = calledUrls.find(u => u.includes('/collections/'));
        const entitiesUrl = calledUrls.find(u => u.includes('/entities/'));
        expect(worksUrl).toContain('attributesToHighlight=description_search');
        expect(booksUrl).toContain('attributesToHighlight=description_search');
        expect(collectionsUrl).not.toContain('attributesToHighlight');
        expect(entitiesUrl).not.toContain('attributesToHighlight');
    });

    it('Authorization header 仅在配置 apiKey 时附加', async () => {
        const fetchMock = jest.fn().mockResolvedValue({
            ok: true,
            json: async () => ({ hits: [], estimatedTotalHits: 0, processingTimeMs: 0 }),
        });
        global.fetch = fetchMock as any;
        const base = makeBase();
        const { wrapWithMeiliSearch } = freshModule();
        const wrapped = wrapWithMeiliSearch(base, { baseUrl: 'http://test', apiKey: 'secret-token' });
        await wrapped.searchAll!('史记', 5);
        const callArgs = fetchMock.mock.calls[0][1];
        expect(callArgs.headers).toMatchObject({ Authorization: 'Bearer secret-token' });
    });
});

describe('meili-storage 代理模式（S1：/api/search）', () => {
    let originalFetch: typeof fetch;
    beforeEach(() => {
        originalFetch = global.fetch;
    });
    afterEach(() => {
        global.fetch = originalFetch;
        jest.clearAllMocks();
    });

    const proxyOk = (results: unknown[]) => jest.fn().mockResolvedValue({
        ok: true, status: 200, json: async () => ({ results }),
    });

    it('searchAll 只发一次同站 GET，浏览器不碰 Meili 地址与 key', async () => {
        const fetchMock = proxyOk([
            { indexUid: 'works', hits: [{ id: 'w1', type: 'work', title: '史記', is_draft: false }], estimatedTotalHits: 7 },
            { indexUid: 'books', hits: [], estimatedTotalHits: 0 },
            { indexUid: 'collections', hits: [], estimatedTotalHits: 0 },
            { indexUid: 'entities', hits: [{ id: 'p1', type: 'entity', primary_name: '司馬遷' }], estimatedTotalHits: 1 },
        ]);
        global.fetch = fetchMock as any;
        const base = makeBase();
        const { wrapWithMeiliSearch, isSearchDegraded } = freshModule();
        const wrapped = wrapWithMeiliSearch(base, { proxyUrl: '/api/search', baseUrl: 'https://meili.example', apiKey: 'k' });
        const r = await wrapped.searchAll!('史記', 5);

        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        expect(url).toBe('/api/search?q=%E5%8F%B2%E8%A8%98&limit=5');
        expect(url).not.toContain('meili.example');
        expect((init as any).headers).toBeUndefined();
        expect(base.searchAll).not.toHaveBeenCalled();
        expect(r.works[0]).toMatchObject({ id: 'w1', title: '史記', isDraft: false });
        expect(r.totalWorks).toBe(7);
        expect(r.entities[0]).toMatchObject({ id: 'p1', title: '司馬遷' });
        expect(isSearchDegraded()).toBe(false);
    });

    it('代理 503：当次就走 L2，并置降级标志（页面显示提示）', async () => {
        global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 503, json: async () => ({}) }) as any;
        const base = makeBase();
        const { wrapWithMeiliSearch, isSearchDegraded, subscribeSearchDegraded } = freshModule();
        const seen: boolean[] = [];
        subscribeSearchDegraded((d: boolean) => seen.push(d));
        const wrapped = wrapWithMeiliSearch(base, { proxyUrl: '/api/search' });
        await wrapped.searchAll!('史記', 5);
        expect(base.searchAll).toHaveBeenCalledWith('史記', 5);
        expect(isSearchDegraded()).toBe(true);
        expect(seen).toEqual([true]);
    });

    it('代理恢复后降级标志清除', async () => {
        const base = makeBase();
        const { wrapWithMeiliSearch, isSearchDegraded } = freshModule();
        const wrapped = wrapWithMeiliSearch(base, { proxyUrl: '/api/search' });
        global.fetch = jest.fn().mockRejectedValue(new Error('network')) as any;
        await wrapped.searchAll!('史記', 5);
        expect(isSearchDegraded()).toBe(true);
        global.fetch = proxyOk([]) as any;
        await wrapped.searchAll!('史記', 5);
        expect(isSearchDegraded()).toBe(false);
    });

    it('连续 3 次失败后熔断：冷却期内不再请求代理', async () => {
        const fetchMock = jest.fn().mockResolvedValue({ ok: false, status: 503, json: async () => ({}) });
        global.fetch = fetchMock as any;
        const base = makeBase();
        const { wrapWithMeiliSearch, getMeiliBreakerState } = freshModule();
        const wrapped = wrapWithMeiliSearch(base, { proxyUrl: '/api/search' });
        for (let i = 0; i < 4; i++) await wrapped.searchAll!('史記', 5);
        expect(fetchMock).toHaveBeenCalledTimes(3);
        expect(base.searchAll).toHaveBeenCalledTimes(4);
        expect(getMeiliBreakerState().open).toBe(true);
    });

    it('400（如查询超长）不计入熔断', async () => {
        global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 400, json: async () => ({}) }) as any;
        const base = makeBase();
        const { wrapWithMeiliSearch, getMeiliBreakerState } = freshModule();
        const wrapped = wrapWithMeiliSearch(base, { proxyUrl: '/api/search' });
        for (let i = 0; i < 4; i++) await wrapped.searchAll!('史記', 5);
        expect(getMeiliBreakerState().failures).toBe(0);
    });

    it('search(type) 翻页：index／limit／offset 参数', async () => {
        const fetchMock = proxyOk([{ indexUid: 'books', hits: [{ id: 'b1', type: 'book', title: '史記' }], estimatedTotalHits: 99 }]);
        global.fetch = fetchMock as any;
        const base = makeBase();
        const { wrapWithMeiliSearch } = freshModule();
        const wrapped = wrapWithMeiliSearch(base, { proxyUrl: '/api/search' });
        const r = await wrapped.search('史記', 'book', { page: 3, pageSize: 20 });
        const url = fetchMock.mock.calls[0][0] as string;
        expect(url).toBe('/api/search?q=%E5%8F%B2%E8%A8%98&index=books&limit=20&offset=40');
        expect(r).toMatchObject({ total: 99, page: 3, pageSize: 20 });
        expect(r.entries[0]).toMatchObject({ id: 'b1' });
    });

    it('search(type) 失败 → base.search', async () => {
        global.fetch = jest.fn().mockRejectedValue(new Error('network')) as any;
        const base = makeBase();
        const { wrapWithMeiliSearch } = freshModule();
        const wrapped = wrapWithMeiliSearch(base, { proxyUrl: '/api/search' });
        await wrapped.search('史記', 'work', { page: 1, pageSize: 20 });
        expect(base.search).toHaveBeenCalled();
    });

    it('代理返回形状不对也当失败 → L2', async () => {
        global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ hits: [] }) }) as any;
        const base = makeBase();
        const { wrapWithMeiliSearch } = freshModule();
        const wrapped = wrapWithMeiliSearch(base, { proxyUrl: '/api/search' });
        await wrapped.searchAll!('史記', 5);
        expect(base.searchAll).toHaveBeenCalled();
    });
});

describe('meili-storage 代理模式：搜索页 v4 筛选（overview#298）', () => {
    let originalFetch: typeof fetch;
    beforeEach(() => { originalFetch = global.fetch; });
    afterEach(() => { global.fetch = originalFetch; jest.clearAllMocks(); });
    const ok = (results: unknown[]) => jest.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ results }) });
    const F = (p: Record<string, unknown>) => ({ dynasty: [], classification: [], hasImage: false, hasText: false, hasCollated: false, loss: '', sort: '', ...p });

    it('searchAll 带筛选：一次 POST multi-search，每类各带自己的 filter；不支持已选字段的类不发、按 0 条', async () => {
        const fetchMock = ok([
            { indexUid: 'works', hits: [{ id: 'w1', type: 'work', title: '史記', classification: '史部', loss_status: 'lost' }], estimatedTotalHits: 9 },
        ]);
        global.fetch = fetchMock as any;
        const { wrapWithMeiliSearch } = freshModule();
        const wrapped = wrapWithMeiliSearch(makeBase(), { proxyUrl: '/api/search' });
        const r = await wrapped.searchAll!('史記', 5, F({ classification: ['史部'], hasImage: true }) as any);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe('/api/search');
        expect(init.method).toBe('POST');
        const body = JSON.parse(init.body);
        // 部类只有 works 支持 → 只发 works；带自己的 filter
        expect(body.queries).toEqual([{ indexUid: 'works', q: '史記', limit: 5, offset: 0, filter: 'classification = "史部" AND has_image = true' }]);
        expect(r.totalWorks).toBe(9);
        expect(r.totalBooks + r.totalCollections + r.totalEntities).toBe(0);
        // 表格的「部类」「存佚」列要的字段都映射进条目
        expect(r.works[0]).toMatchObject({ id: 'w1', classification: '史部', loss_status: 'lost' });
    });

    it('朝代筛选对 works／books／entities 发 IN 串，丛编不发', async () => {
        const fetchMock = ok([]);
        global.fetch = fetchMock as any;
        const { wrapWithMeiliSearch } = freshModule();
        await wrapWithMeiliSearch(makeBase(), { proxyUrl: '/api/search' }).searchAll!('史記', 5, F({ dynasty: ['明'] }) as any);
        const qs = JSON.parse(fetchMock.mock.calls[0][1].body).queries;
        expect(qs.map((x: any) => x.indexUid).sort()).toEqual(['books', 'entities', 'works']);
        expect(qs.every((x: any) => x.filter === 'dynasty IN ["明", "明末清初"]')).toBe(true);
    });

    it('没有筛选：仍是原来的 GET（可被边缘缓存），不发 POST', async () => {
        const fetchMock = ok([]);
        global.fetch = fetchMock as any;
        const { wrapWithMeiliSearch } = freshModule();
        await wrapWithMeiliSearch(makeBase(), { proxyUrl: '/api/search' }).searchAll!('史記', 5, F({}) as any);
        expect(fetchMock.mock.calls[0][0]).toBe('/api/search?q=%E5%8F%B2%E8%A8%98&limit=5');
        expect(fetchMock.mock.calls[0][1].method).toBe('GET');
    });

    it('search(type) 带筛选：filter 参数；不支持的类直接 0 条不发请求；翻页 offset 照旧', async () => {
        const fetchMock = ok([{ indexUid: 'works', hits: [], estimatedTotalHits: 0 }]);
        global.fetch = fetchMock as any;
        const { wrapWithMeiliSearch } = freshModule();
        const wrapped = wrapWithMeiliSearch(makeBase(), { proxyUrl: '/api/search' });
        await wrapped.search('史記', 'work', { page: 2, pageSize: 50, filters: F({ loss: 'lost' }) as any });
        const params = new URL(fetchMock.mock.calls[0][0], 'http://x').searchParams;
        expect(params.get('filter')).toBe('loss_status = "lost"');
        expect(params.get('offset')).toBe('50');
        const none = await wrapped.search('史記', 'book', { page: 1, pageSize: 50, filters: F({ loss: 'lost' }) as any });
        expect(none).toMatchObject({ entries: [], total: 0 });
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('带筛选时代理失败：不退回不认筛选的简易搜索（免得「筛了但没筛」），抛一句人话；400 说条件太多', async () => {
        const base = makeBase();
        const { wrapWithMeiliSearch } = freshModule();
        global.fetch = jest.fn().mockRejectedValue(new Error('network')) as any;
        const wrapped = wrapWithMeiliSearch(base, { proxyUrl: '/api/search' });
        await expect(wrapped.searchAll!('史記', 5, F({ dynasty: ['清'] }) as any)).rejects.toThrow('筛选需要完整搜索');
        expect(base.searchAll).not.toHaveBeenCalled();
        const { wrapWithMeiliSearch: w2 } = freshModule();
        global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 400, json: async () => ({}) }) as any;
        await expect(w2(makeBase(), { proxyUrl: '/api/search' }).search('史記', 'work', { filters: F({ dynasty: ['清'] }) as any })).rejects.toThrow('筛选条件太多');
    });

    it('只有排序（无筛选）：searchAll 也走 POST；丛编不带 sort，其余三类带对应的键', async () => {
        const fetchMock = ok([]);
        global.fetch = fetchMock as any;
        const { wrapWithMeiliSearch } = freshModule();
        await wrapWithMeiliSearch(makeBase(), { proxyUrl: '/api/search' }).searchAll!('史記', 5, F({ sort: 'era:desc' }) as any);
        expect(fetchMock.mock.calls[0][1].method).toBe('POST');
        const qs = JSON.parse(fetchMock.mock.calls[0][1].body).queries;
        expect(qs).toHaveLength(4);
        for (const x of qs) {
          if (x.indexUid === 'collections') expect(x.sort).toBeUndefined();
          else expect(x.sort).toBe('era:desc');
          expect(x.filter).toBeUndefined();
        }
    });

    it('search(type) 带 sort：GET 参数 sort；丛编不带', async () => {
        const fetchMock = ok([{ indexUid: 'works', hits: [], estimatedTotalHits: 0 }]);
        global.fetch = fetchMock as any;
        const { wrapWithMeiliSearch } = freshModule();
        const wrapped = wrapWithMeiliSearch(makeBase(), { proxyUrl: '/api/search' });
        await wrapped.search('史記', 'work', { page: 1, pageSize: 50, filters: F({ sort: 'title:asc' }) as any });
        expect(new URL(fetchMock.mock.calls[0][0], 'http://x').searchParams.get('sort')).toBe('title:asc');
        await wrapped.search('史記', 'collection', { page: 1, pageSize: 50, filters: F({ sort: 'title:asc' }) as any });
        expect(new URL(fetchMock.mock.calls[1][0], 'http://x').searchParams.has('sort')).toBe(false);
    });

    it('代理模式声明 supportsSearchFilters（搜索页据此显示筛选栏）；直连回退模式不声明', () => {
        const { wrapWithMeiliSearch } = freshModule();
        expect((wrapWithMeiliSearch(makeBase(), { proxyUrl: '/api/search' }) as any).supportsSearchFilters).toBe(true);
        expect((wrapWithMeiliSearch(makeBase(), { baseUrl: 'https://meili.example', apiKey: 'k' }) as any).supportsSearchFilters).toBeUndefined();
    });
});
