/**
 * cos-storage：丛编页取目录时，丛编详情只取一次（overview#371 之后的 e2e 回归）。
 *
 * inner（BundleStorage）的 getCollectionCatalogs 内部调 this.getItem；原先它按自己的 URL 再取一次
 * entry/{丛编}.json，和外层已取过的那次重复。现在 inner 的 getItem／getEntry 改走外层同一条路径与缓存。
 */
import { jest } from '@jest/globals';

jest.mock('../error-report', () => ({ reportError: jest.fn(), setRelease: jest.fn() }));

const COS_BASE = 'https://data.example.com';
const COLL = '8rlcsybg2hhf';
const DETAIL = { id: COLL, type: 'collection', title: '武英殿聚珍版書', resources: [{ id: 'wikimedia', short_name: '維基共享' }] };
const MAPPING = { volumes: [{ volume: 1, books: [{ title: '甲', work_id: 'w1' }] }] };

function jsonResponse(body: unknown, ok = true, status = 200) {
    return { ok, status, json: async () => body, text: async () => JSON.stringify(body) } as Response;
}

async function freshCosStorage() {
    const prevLayout = process.env.NEXT_PUBLIC_DATA_LAYOUT;
    const prevBase = process.env.NEXT_PUBLIC_COS_BASE;
    delete process.env.NEXT_PUBLIC_DATA_LAYOUT;
    process.env.NEXT_PUBLIC_COS_BASE = COS_BASE;
    let mod!: typeof import('../cos-storage');
    await jest.isolateModulesAsync(async () => { mod = await import('../cos-storage'); });
    if (prevLayout === undefined) delete process.env.NEXT_PUBLIC_DATA_LAYOUT; else process.env.NEXT_PUBLIC_DATA_LAYOUT = prevLayout;
    if (prevBase === undefined) delete process.env.NEXT_PUBLIC_COS_BASE; else process.env.NEXT_PUBLIC_COS_BASE = prevBase;
    return mod;
}

describe('cos-storage：丛编目录', () => {
    let originalFetch: typeof fetch;
    beforeEach(() => {
        originalFetch = global.fetch;
        // jsdom 没有 AbortSignal.timeout，BundleStorage 取数前会抛
        const as = AbortSignal as unknown as { timeout?: (ms: number) => AbortSignal };
        if (!as.timeout) as.timeout = () => new AbortController().signal;
    });
    afterEach(() => { global.fetch = originalFetch; });

    it('页面先取详情、再取丛编目录：entry/{丛编}.json 只请求一次，不请求 chunks/', async () => {
        const calls: string[] = [];
        global.fetch = jest.fn().mockImplementation(async (url: string) => {
            calls.push(url);
            if (url.endsWith('/latest.json')) return jsonResponse({ commitId: 'abc123def456789' });
            if (url.includes(`/entry/${COLL}.json`)) return jsonResponse(DETAIL);
            if (url.includes(`/items/${COLL}/wikimedia/volume_book_mapping.json`)) return jsonResponse(MAPPING);
            return jsonResponse({}, false, 404);
        }) as unknown as typeof fetch;
        const { createCosStorage } = await freshCosStorage();
        const storage = createCosStorage();

        expect(await storage.getItem(COLL)).toMatchObject({ id: COLL, title: '武英殿聚珍版書' });
        const catalogs = await storage.getCollectionCatalogs?.(COLL);
        expect(catalogs).toHaveLength(1);
        expect(catalogs![0]).toMatchObject({ resource_id: 'wikimedia', short_name: '維基共享' });

        expect(calls.filter((u) => u.includes(`/entry/${COLL}.json`))).toHaveLength(1);
        expect(calls.some((u) => u.includes('/chunks/'))).toBe(false);
    });
});
