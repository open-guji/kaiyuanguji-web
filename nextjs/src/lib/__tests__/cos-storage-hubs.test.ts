/**
 * cos-storage：getHubs()——枢纽名称表 _hubs.json（schema-v2，overview#458）。
 * 有就返回；旧 schema 的包里没有该文件（404）、网络错、JSON 坏都返回 null，不抛错；只取一次。
 */
import { jest } from '@jest/globals';

jest.mock('../error-report', () => ({ reportError: jest.fn(), setRelease: jest.fn() }));

const COS_BASE = 'https://data.example.com';
const HUBS = { '8rlcsybg2hhf': { t: 'c', title: '武英殿聚珍版叢書' }, hixhd2h9bhma: { t: 'e', title: '司馬遷', dyn: '西漢' } };

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

type WithHubs = { getHubs?: () => Promise<Record<string, unknown> | null> };

describe('cos-storage：getHubs', () => {
    let originalFetch: typeof fetch;
    beforeEach(() => { originalFetch = global.fetch; });
    afterEach(() => { global.fetch = originalFetch; });

    function mockFetch(hubs: (url: string) => Response | Promise<Response>) {
        const calls: string[] = [];
        global.fetch = jest.fn().mockImplementation(async (url: string) => {
            calls.push(url);
            if (url.endsWith('/latest.json') || url.includes('/latest.json?')) return jsonResponse({ commitId: 'abc123def456789' });
            if (url.includes('/_hubs.json')) return hubs(url);
            return jsonResponse({}, false, 404);
        }) as unknown as typeof fetch;
        return calls;
    }

    it('有 _hubs.json：返回名称表，带版本参数，只请求一次', async () => {
        const calls = mockFetch(() => jsonResponse(HUBS));
        const { createCosStorage } = await freshCosStorage();
        const storage = createCosStorage() as unknown as WithHubs;
        expect(await storage.getHubs!()).toEqual(HUBS);
        expect(await storage.getHubs!()).toEqual(HUBS);
        const hubCalls = calls.filter((u) => u.includes('/_hubs.json'));
        expect(hubCalls).toHaveLength(1);
        expect(hubCalls[0]).toMatch(/^https:\/\/data\.example\.com\/.*_hubs\.json\?v=/);
    });

    it('旧 schema 的包没有该文件（404）：返回 null，不抛错，也只请求一次', async () => {
        const calls = mockFetch(() => jsonResponse({}, false, 404));
        const { createCosStorage } = await freshCosStorage();
        const storage = createCosStorage() as unknown as WithHubs;
        expect(await storage.getHubs!()).toBeNull();
        expect(await storage.getHubs!()).toBeNull();
        expect(calls.filter((u) => u.includes('/_hubs.json'))).toHaveLength(1);
    });

    it('网络错、JSON 坏、不是对象：都返回 null', async () => {
        for (const make of [
            () => { throw new Error('network'); },
            () => ({ ok: true, status: 200, json: async () => { throw new Error('bad json'); } } as unknown as Response),
            () => jsonResponse([1, 2, 3]),
        ]) {
            mockFetch(make as (url: string) => Response);
            const { createCosStorage } = await freshCosStorage();
            const storage = createCosStorage() as unknown as WithHubs;
            expect(await storage.getHubs!()).toBeNull();
        }
    });
});
