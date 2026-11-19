/**
 * cos-storage：getBookGroupPage()——千本级作品的版本分组分页 book-groups/<wid>/<g>/<n>.json
 *（book-index build_derived 契约 5）。有就返回 Book 卡数组；404、网络错、不是数组、参数不安全都回 null。
 */
import { jest } from '@jest/globals';

jest.mock('../error-report', () => ({ reportError: jest.fn(), setRelease: jest.fn() }));

const COS_BASE = 'https://data.example.com';
const PAGE = [{ id: 'b1', coll: 'cA' }, { id: 'b2', coll: 'cA' }];

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

type WithPages = { getBookGroupPage?: (w: string, g: string, n: number) => Promise<unknown[] | null> };

describe('cos-storage：getBookGroupPage', () => {
    let originalFetch: typeof fetch;
    beforeEach(() => { originalFetch = global.fetch; });
    afterEach(() => { global.fetch = originalFetch; });

    function mockFetch(page: (url: string) => Response | Promise<Response>) {
        const calls: string[] = [];
        global.fetch = jest.fn().mockImplementation(async (url: string) => {
            calls.push(url);
            if (url.includes('/latest.json')) return jsonResponse({ commitId: 'abc123def456789' });
            if (url.includes('/book-groups/')) return page(url);
            return jsonResponse({}, false, 404);
        }) as unknown as typeof fetch;
        return calls;
    }

    it('取到分页：返回卡片数组，路径带版本参数', async () => {
        const calls = mockFetch(() => jsonResponse(PAGE));
        const { createCosStorage } = await freshCosStorage();
        const storage = createCosStorage() as unknown as WithPages;
        expect(await storage.getBookGroupPage!('w1', '_none', 2)).toEqual(PAGE);
        const hit = calls.filter((u) => u.includes('/book-groups/'));
        expect(hit).toHaveLength(1);
        expect(hit[0]).toMatch(/^https:\/\/data\.example\.com\/.*book-groups\/w1\/_none\/2\.json\?v=/);
    });

    it('404、网络错、不是数组：null', async () => {
        for (const make of [
            () => jsonResponse({}, false, 404),
            () => { throw new Error('network'); },
            () => jsonResponse({ not: 'array' }),
        ]) {
            mockFetch(make as (url: string) => Response);
            const { createCosStorage } = await freshCosStorage();
            const storage = createCosStorage() as unknown as WithPages;
            expect(await storage.getBookGroupPage!('w1', 'cA', 1)).toBeNull();
        }
    });

    it('参数不安全：不发请求，直接 null', async () => {
        const calls = mockFetch(() => jsonResponse(PAGE));
        const { createCosStorage } = await freshCosStorage();
        const storage = createCosStorage() as unknown as WithPages;
        expect(await storage.getBookGroupPage!('../x', 'cA', 1)).toBeNull();
        expect(await storage.getBookGroupPage!('w1', 'cA', 0)).toBeNull();
        expect(calls.filter((u) => u.includes('/book-groups/'))).toHaveLength(0);
    });
});
