/**
 * overview#169：current/ 的 ?v= 与 search 分片路径改用三仓合成键 cacheKey。
 *
 * 此前版本号只是 draft 仓的 commitId —— 只有 production 或 book-text 变的发布，
 * URL 一字不变，immutable 缓存一直吐旧版（DQ 实测抽样 18% 条目命中旧缓存）。
 *
 * 覆盖三层：
 *   1. 脚本侧 latestCacheKey（sync-to-cos.mjs 往 latest.json 补的字段）：
 *      只 production 变／只 text 变／只 draft 变，键都要变
 *   2. 前端口径 dataVersionKey：优先 cacheKey，缺字段回退 commitId（新旧混跑）
 *   3. cos-storage 真正拼出来的 URL：entry 的 ?v= 与 v/<key>/search
 */
import { jest } from '@jest/globals';
import { latestCacheKey, withCacheKey } from '../../../scripts/lib/latest-cache-key.mjs';
import { dataCommitKey } from '../../../scripts/lib/h1-hash-common.mjs';
import { dataVersionKey } from '../data-version';

jest.mock('../error-report', () => ({
    reportError: jest.fn(),
    setRelease: jest.fn(),
}));

const BASE_LATEST = {
    commitId: 'aaaaaaaaaaaa',
    fullCommitId: 'aaaaaaaaaaaa1111111111111111111111111111',
    productionCommitId: 'bbbbbbbbbbbb2222222222222222222222222222',
    textCommitId: 'cccccccccccc3333333333333333333333333333',
    commitDate: '2026-09-28T00:00:00Z',
    bundleDate: '2026-09-28T01:00:00Z',
};

describe('latestCacheKey（脚本侧，写进 latest.json.cacheKey）', () => {
    const k0 = latestCacheKey(BASE_LATEST);

    it('只有 production 变 → 键变', () => {
        expect(latestCacheKey({ ...BASE_LATEST, productionCommitId: 'dddd' })).not.toBe(k0);
    });

    it('只有 text 变 → 键变', () => {
        expect(latestCacheKey({ ...BASE_LATEST, textCommitId: 'eeee' })).not.toBe(k0);
    });

    it('只有 draft 变 → 键变', () => {
        expect(latestCacheKey({ ...BASE_LATEST, commitId: 'ffffffffffff', fullCommitId: 'ffffffffffff9999' })).not.toBe(k0);
    });

    it('三仓都不变、只有打包时间变 → 键不变（不无谓冲缓存）', () => {
        expect(latestCacheKey({ ...BASE_LATEST, bundleDate: '2026-09-29T00:00:00Z' })).toBe(k0);
    });

    it('与同一次发布 h1 roots/<key>.json 的 key 一致（version.json 三字段同源）', () => {
        expect(k0).toBe(dataCommitKey({
            commitId: BASE_LATEST.fullCommitId,
            productionCommitId: BASE_LATEST.productionCommitId,
            textCommitId: BASE_LATEST.textCommitId,
        }));
    });

    it('withCacheKey 保留原字段、只补 cacheKey', () => {
        const out = withCacheKey(BASE_LATEST);
        expect(out).toEqual({ ...BASE_LATEST, cacheKey: k0 });
        expect(out.cacheKey).toMatch(/^[0-9a-f]{16}$/);
        expect(out.cacheKey).not.toBe(BASE_LATEST.commitId);
    });
});

describe('dataVersionKey（前端口径）', () => {
    it('有 cacheKey 用 cacheKey', () => {
        expect(dataVersionKey({ commitId: 'c1', cacheKey: 'k1' })).toBe('k1');
    });
    it('旧 latest.json 没有 cacheKey → 回退 commitId', () => {
        expect(dataVersionKey({ commitId: 'c1' })).toBe('c1');
    });
    it('都没有 → undefined', () => {
        expect(dataVersionKey({})).toBeUndefined();
        expect(dataVersionKey(null)).toBeUndefined();
    });
});

describe('cos-storage 拼出的 URL', () => {
    const COS_BASE = 'https://data.example.com';
    const WORK_ID = 'd59df01avcw0';
    let originalFetch: typeof fetch;

    beforeEach(() => {
        originalFetch = global.fetch;
        jest.clearAllMocks();
    });
    afterEach(() => {
        global.fetch = originalFetch;
    });

    async function fresh() {
        const prevBase = process.env.NEXT_PUBLIC_COS_BASE;
        const prevLayout = process.env.NEXT_PUBLIC_DATA_LAYOUT;
        process.env.NEXT_PUBLIC_COS_BASE = COS_BASE;
        delete process.env.NEXT_PUBLIC_DATA_LAYOUT;
        let mod!: typeof import('../cos-storage');
        let report!: typeof import('../error-report');
        await jest.isolateModulesAsync(async () => {
            mod = await import('../cos-storage');
            report = await import('../error-report');
        });
        if (prevBase === undefined) delete process.env.NEXT_PUBLIC_COS_BASE;
        else process.env.NEXT_PUBLIC_COS_BASE = prevBase;
        if (prevLayout !== undefined) process.env.NEXT_PUBLIC_DATA_LAYOUT = prevLayout;
        return { mod, report };
    }

    function mockFetch(latest: Record<string, string>) {
        const calls: string[] = [];
        global.fetch = jest.fn().mockImplementation(async (url: string) => {
            calls.push(url);
            const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as Response;
            if (url.endsWith('/latest.json')) return ok(latest);
            if (url.includes('/promotions.json')) return ok({ version: 1, promotions: {} });
            if (url.includes(`/current/entry/${WORK_ID}.json`)) return ok({ id: WORK_ID, title: '尚書正義' });
            throw new Error(`unexpected fetch: ${url}`);
        }) as unknown as typeof fetch;
        return calls;
    }

    it('latest.json 带 cacheKey：entry 的 ?v= 与 search 路径都用 cacheKey；错误上报仍记 commitId', async () => {
        const calls = mockFetch({ commitId: 'draftcommit1', cacheKey: '0123456789abcdef' });
        const { mod, report } = await fresh();
        await mod.createCosStorage().getItem(WORK_ID);
        expect(calls).toContain(`${COS_BASE}/current/entry/${WORK_ID}.json?v=0123456789abcdef`);
        expect(calls).toContain(`${COS_BASE}/current/promotions.json?v=0123456789abcdef`);
        expect(calls.some((u) => u.includes('?v=draftcommit1'))).toBe(false);
        expect(await mod.getCosSearchBaseUrl()).toBe(`${COS_BASE}/v/0123456789abcdef/search`);
        expect(report.setRelease).toHaveBeenCalledWith('draftcommit1');
    });

    it('旧 latest.json 没有 cacheKey：回退 commitId（新前端 + 旧数据）', async () => {
        const calls = mockFetch({ commitId: 'draftcommit1' });
        const { mod } = await fresh();
        await mod.createCosStorage().getItem(WORK_ID);
        expect(calls).toContain(`${COS_BASE}/current/entry/${WORK_ID}.json?v=draftcommit1`);
        expect(await mod.getCosSearchBaseUrl()).toBe(`${COS_BASE}/v/draftcommit1/search`);
    });
});
