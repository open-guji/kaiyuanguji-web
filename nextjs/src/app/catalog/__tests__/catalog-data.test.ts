/**
 * @jest-environment node
 *
 * 古籍总目服务端取数（N4b）：带版本键读 current/catalog/，404 返回 null，5xx 抛错，缓存。
 */
import { describe, it, expect, jest } from '@jest/globals';
import { createCatalogFetcher } from '../catalog-data';

const BASE = 'https://data.example.com/staging';

function mockFetch(routes: Record<string, unknown>) {
    const calls: string[] = [];
    const fn = jest.fn(async (url: string) => {
        calls.push(url);
        const key = url.split('?')[0];
        if (!(key in routes)) return { ok: false, status: 404, json: async () => ({}) } as Response;
        const v = routes[key];
        if (typeof v === 'number') return { ok: v < 400, status: v, json: async () => ({}) } as Response;
        return { ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(v)) } as Response;
    });
    return { fn, calls };
}

const TREE = [{ id: 'cshi', label: '史部', count: 1 }];
const PAGE = [{ id: 'd59f282rkphc', title: '三國志' }];

describe('createCatalogFetcher', () => {
    it('带 cacheKey 读 tree 与分页；同一版本只取一次', async () => {
        const { fn, calls } = mockFetch({
            [`${BASE}/latest.json`]: { commitId: 'abc', cacheKey: 'k1' },
            [`${BASE}/current/catalog/tree.json`]: TREE,
            [`${BASE}/current/catalog/cshi/1.json`]: PAGE,
        });
        const f = createCatalogFetcher({ base: `${BASE}/`, fetch: fn, now: () => 0 });
        expect(await f.getTree()).toEqual(TREE);
        expect(await f.getTree()).toEqual(TREE);
        expect(await f.getPage('cshi', 1)).toEqual(PAGE);
        expect(calls).toEqual([
            `${BASE}/latest.json?t=0`,
            `${BASE}/current/catalog/tree.json?v=k1`,
            `${BASE}/current/catalog/cshi/1.json?v=k1`,
        ]);
    });

    it('没有 cacheKey 回退 commitId', async () => {
        const { fn, calls } = mockFetch({
            [`${BASE}/latest.json`]: { commitId: 'abc' },
            [`${BASE}/current/catalog/tree.json`]: TREE,
        });
        await createCatalogFetcher({ base: BASE, fetch: fn, now: () => 0 }).getTree();
        expect(calls[1]).toBe(`${BASE}/current/catalog/tree.json?v=abc`);
    });

    it('404：null；5xx：抛错且不缓存失败', async () => {
        const routes: Record<string, unknown> = {
            [`${BASE}/latest.json`]: { cacheKey: 'k1' },
            [`${BASE}/current/catalog/tree.json`]: 502,
        };
        const { fn } = mockFetch(routes);
        const f = createCatalogFetcher({ base: BASE, fetch: fn, now: () => 0 });
        expect(await f.getPage('cnope', 1)).toBeNull();
        await expect(f.getTree()).rejects.toThrow('HTTP 502');
        routes[`${BASE}/current/catalog/tree.json`] = TREE;
        expect(await f.getTree()).toEqual(TREE);
    });

    it('latest.json 过期后重取，换版本键', async () => {
        let t = 0;
        const routes: Record<string, unknown> = {
            [`${BASE}/latest.json`]: { cacheKey: 'k1' },
            [`${BASE}/current/catalog/tree.json`]: TREE,
        };
        const { fn, calls } = mockFetch(routes);
        const f = createCatalogFetcher({ base: BASE, fetch: fn, now: () => t, pointerTtlMs: 1000 });
        await f.getTree();
        routes[`${BASE}/latest.json`] = { cacheKey: 'k2' };
        t = 1500;
        await f.getTree();
        expect(calls.filter((u) => u.includes('tree.json'))).toEqual([
            `${BASE}/current/catalog/tree.json?v=k1`,
            `${BASE}/current/catalog/tree.json?v=k2`,
        ]);
    });
});
