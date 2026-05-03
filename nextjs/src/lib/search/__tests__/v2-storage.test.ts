/**
 * v2-storage 单测
 *
 * 关键回归：
 * 1. searchAll 直接走 worker hits，不调 base.getAllEntries（曾经那条会拉 23 MB index.json）
 * 2. hits 的所有字段（含详情字段如 has_collated / juan_count / additional_titles）正确映射到 IndexEntry
 * 3. entity 桶被处理（早期 v2 EntryType 不含 entity 是 bug）
 * 4. 空 query 立即返回空，不打扰 worker
 */
import { wrapWithV2Search, isV2SearchEnabled } from '../v2-storage';
import type { IndexStorage } from 'book-index-ui/storage';

// mock 整个 client 模块 — vitest/jest 都能用 jest.mock
jest.mock('../client', () => ({
    getSearchClient: jest.fn(),
}));
import { getSearchClient } from '../client';

function makeBase(overrides: Partial<IndexStorage> = {}): IndexStorage {
    return {
        loadEntries: jest.fn().mockResolvedValue({ entries: [], total: 0, page: 1, pageSize: 50 }),
        search: jest.fn(),
        searchAll: jest.fn(),
        getItem: jest.fn().mockResolvedValue(null),
        saveItem: jest.fn(),
        deleteItem: jest.fn(),
        generateId: jest.fn(),
        getAllEntries: jest.fn(),
        ...overrides,
    } as unknown as IndexStorage;
}

describe('v2-storage', () => {
    beforeEach(() => jest.clearAllMocks());

    it('isV2SearchEnabled 默认 true（index.json 已剥离，必须走 worker）', () => {
        expect(isV2SearchEnabled()).toBe(true);
    });

    it('searchAll 直接转 hits，不调 base.getAllEntries', async () => {
        const mockClient = {
            searchAll: jest.fn().mockResolvedValue({
                works: [{
                    id: 'w1', type: 'work', title: '史記', author: '司馬遷',
                    dynasty: '漢', has_collated: true, juan_count: 130,
                    additional_titles: ['太史公書'],
                    score: 1,
                }],
                books: [], collections: [], entities: [],
                totalWorks: 1, totalBooks: 0, totalCollections: 0, totalEntities: 0,
            }),
            searchEntries: jest.fn(),
            init: jest.fn(),
        };
        (getSearchClient as jest.Mock).mockReturnValue(mockClient);

        const base = makeBase();
        const wrapped = wrapWithV2Search(base);
        const result = await wrapped.searchAll!('史記', 5);

        // 关键回归：base.getAllEntries 绝不被调（曾经的 hydration 路径）
        expect(base.getAllEntries).not.toHaveBeenCalled();

        // worker 被调
        expect(mockClient.searchAll).toHaveBeenCalledWith('史記', 5);

        // 字段映射完整
        expect(result.works).toHaveLength(1);
        expect(result.works[0]).toMatchObject({
            id: 'w1',
            type: 'work',
            title: '史記',
            author: '司馬遷',
            dynasty: '漢',
            has_collated: true,
            juan_count: 130,
            additional_titles: ['太史公書'],
        });
        expect(result.totalWorks).toBe(1);
    });

    it('entities 桶被处理 — entity 类型曾经在 v2 worker 里被忽略', async () => {
        const mockClient = {
            searchAll: jest.fn().mockResolvedValue({
                works: [], books: [], collections: [],
                entities: [{
                    id: 'e1', type: 'entity', title: '孔子',
                    primary_name: '孔子', dynasty: '周',
                    score: 1,
                }],
                totalWorks: 0, totalBooks: 0, totalCollections: 0, totalEntities: 1,
            }),
            searchEntries: jest.fn(),
            init: jest.fn(),
        };
        (getSearchClient as jest.Mock).mockReturnValue(mockClient);

        const wrapped = wrapWithV2Search(makeBase());
        const result = await wrapped.searchAll!('孔子', 5);

        expect(result.entities).toHaveLength(1);
        expect(result.entities![0]).toMatchObject({
            id: 'e1',
            type: 'entity',
            primary_name: '孔子',
        });
        expect(result.totalEntities).toBe(1);
    });

    it('空 query 立即返回空，不调 worker', async () => {
        const mockClient = { searchAll: jest.fn(), searchEntries: jest.fn(), init: jest.fn() };
        (getSearchClient as jest.Mock).mockReturnValue(mockClient);

        const wrapped = wrapWithV2Search(makeBase());
        const result = await wrapped.searchAll!('   ', 5);

        expect(mockClient.searchAll).not.toHaveBeenCalled();
        expect(result.works).toEqual([]);
        expect(result.totalEntities).toBe(0);
    });

    it('search(type) 也走 worker，不调 base.getAllEntries', async () => {
        const mockClient = {
            searchAll: jest.fn(),
            searchEntries: jest.fn().mockResolvedValue({
                hits: [{ id: 'w1', type: 'work', title: '論語', author: '孔子', score: 1 }],
                total: 1, page: 1, pageSize: 50,
            }),
            init: jest.fn(),
        };
        (getSearchClient as jest.Mock).mockReturnValue(mockClient);

        const base = makeBase();
        const wrapped = wrapWithV2Search(base);
        const result = await wrapped.search('論語', 'work', { page: 1, pageSize: 50 });

        expect(base.getAllEntries).not.toHaveBeenCalled();
        expect(mockClient.searchEntries).toHaveBeenCalledWith('論語', 'work', 1, 50);
        expect(result.entries).toHaveLength(1);
        expect(result.entries[0].title).toBe('論語');
    });

    it('Proxy 透传非搜索方法到 base — getCounts/getEntry 等不被劫持', async () => {
        const getCounts = jest.fn().mockResolvedValue({ works: 100, books: 0, collections: 0, entities: 0,
            resourceCounts: { hasText: 0, hasImage: 0 }, subtypeStats: {} });
        const base = makeBase({ getCounts } as any);
        const wrapped = wrapWithV2Search(base);

        const counts = await (wrapped as any).getCounts();
        expect(counts.works).toBe(100);
        expect(getCounts).toHaveBeenCalled();
    });
});
