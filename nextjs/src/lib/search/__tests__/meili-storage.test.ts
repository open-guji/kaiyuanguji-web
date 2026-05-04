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

    it('search(type) 单次 L1 失败返回空，不透传到 base.search', async () => {
        global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 503, text: async () => '' }) as any;
        const base = makeBase();
        const { wrapWithMeiliSearch } = freshModule();
        const wrapped = wrapWithMeiliSearch(base, { baseUrl: 'http://test' });
        const r = await wrapped.search('q', 'work', { page: 1, pageSize: 50 });
        expect(base.search).not.toHaveBeenCalled();
        expect(r.entries).toEqual([]);
        expect(r.total).toBe(0);
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
