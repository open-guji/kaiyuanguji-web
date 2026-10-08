/**
 * cos-storage.ts：浏览器端升格对照表（草稿 id → 正式 id）按 PH 分片取，不整表下载
 * （overview#458 批次 0.3；集部升格放量后 promotions.json 约 14 MB）。
 *
 * 取数链路与服务端 item-data.ts 的 resolvePromotion 相同：指针 → root.promotionShards → h1/promotions/<后缀>.<hash8>.json。
 * 与条目的 DATA_LAYOUT 无关（线上默认是旧布局，条目仍读 current/）。h1 答不了时退回整张 promotions.json。
 * COS_BASE 是模块级常量，每个用例用 isolateModulesAsync 拿新实例。
 */
import { jest } from '@jest/globals';

jest.mock('../error-report', () => ({ reportError: jest.fn(), setRelease: jest.fn() }));

const COS_BASE = 'https://data.example.com';
const DRAFT = '1evr5e3mct1mt'; // 末 2 位 'mt'
const DRAFT_SAME_SHARD = '1evr5e3mcx9mt';
const PROD = 'd59df01avcw0';
const OTHER = 'd59f20aowb9c'; // 末 2 位 '9c'，root 里没有这个后缀的升格
const ROOT_KEY = 'root1';
const SHARD_HASH = 'abcd1234';

function jsonResponse(body: unknown, ok = true, status = 200) {
    return { ok, status, json: async () => body } as Response;
}

async function fresh() {
    const prev = process.env.NEXT_PUBLIC_COS_BASE;
    delete process.env.NEXT_PUBLIC_DATA_LAYOUT;
    process.env.NEXT_PUBLIC_COS_BASE = COS_BASE;
    let mod!: typeof import('../cos-storage');
    await jest.isolateModulesAsync(async () => { mod = await import('../cos-storage'); });
    if (prev === undefined) delete process.env.NEXT_PUBLIC_COS_BASE;
    else process.env.NEXT_PUBLIC_COS_BASE = prev;
    return mod;
}

interface Opts {
    promotionShards?: Record<string, string> | null; // null＝root 里没有这个字段
    pointerStatus?: number;
    shardStatus?: number;
    wholeFile?: Record<string, { production_id: string }>;
}

function mockFetch(opts: Opts = {}) {
    const calls: string[] = [];
    const promotionShards = opts.promotionShards === undefined ? { mt: SHARD_HASH } : opts.promotionShards;
    global.fetch = jest.fn().mockImplementation(async (url: string) => {
        calls.push(url);
        if (url.endsWith('/latest.json')) return jsonResponse({ commitId: 'c1' });
        if (url.endsWith('/h1/manifest-root.json')) {
            return opts.pointerStatus ? jsonResponse({}, false, opts.pointerStatus) : jsonResponse({ version: 2, root: `${ROOT_KEY}.json` });
        }
        if (url.endsWith(`/h1/roots/${ROOT_KEY}.json`)) {
            const doc: Record<string, unknown> = { version: 1, shardKeyLength: 2, shardSpace: 1296, shardCount: 0, shards: {} };
            if (promotionShards !== null) doc.promotionShards = promotionShards;
            return jsonResponse(doc);
        }
        if (url.endsWith(`/h1/promotions/mt.${SHARD_HASH}.json`)) {
            return opts.shardStatus ? jsonResponse({}, false, opts.shardStatus) : jsonResponse({ [DRAFT]: PROD, [DRAFT_SAME_SHARD]: PROD });
        }
        if (url.includes('/promotions.json')) {
            return jsonResponse({ version: 1, promotions: opts.wholeFile ?? { [DRAFT]: { production_id: PROD } } });
        }
        if (url.includes(`/current/entry/${PROD}.json`)) return jsonResponse({ id: PROD, title: '正式条目' });
        if (url.includes(`/current/entry/${OTHER}.json`)) return jsonResponse({ id: OTHER, title: '普通条目' });
        throw new Error(`unexpected fetch: ${url}`);
    }) as unknown as typeof fetch;
    return calls;
}

describe('cos-storage：升格对照表按 PH 分片取', () => {
    let originalFetch: typeof fetch;
    beforeEach(() => { originalFetch = global.fetch; jest.clearAllMocks(); });
    afterEach(() => { global.fetch = originalFetch; });

    it('草稿 id：只取它所在的一片，跳到正式 id，不下整张 promotions.json', async () => {
        const calls = mockFetch();
        const storage = (await fresh()).createCosStorage();
        const item = await storage.getItem(DRAFT);
        expect(item).toMatchObject({ id: PROD, redirected_from: DRAFT });
        expect(calls.some(u => u.endsWith(`/h1/promotions/mt.${SHARD_HASH}.json`))).toBe(true);
        expect(calls.some(u => u.includes('/promotions.json'))).toBe(false);
        expect(calls.some(u => u.includes(`/current/entry/${PROD}.json`))).toBe(true);
    });

    it('同一片里的两个 id 只取一次分片', async () => {
        const calls = mockFetch();
        const storage = (await fresh()).createCosStorage();
        await storage.getItem(DRAFT);
        await storage.getItem(DRAFT_SAME_SHARD);
        expect(calls.filter(u => u.includes('/h1/promotions/')).length).toBe(1);
    });

    it('同一片并发取（Promise.all）也只发一次请求，指针与 root 也各一次', async () => {
        const calls = mockFetch();
        const storage = (await fresh()).createCosStorage();
        await Promise.all([storage.getItem(DRAFT), storage.getItem(DRAFT_SAME_SHARD), storage.getEntry(DRAFT)]);
        expect(calls.filter(u => u.includes('/h1/promotions/')).length).toBe(1);
        expect(calls.filter(u => u.endsWith('/h1/manifest-root.json')).length).toBe(1);
        expect(calls.filter(u => u.includes('/h1/roots/')).length).toBe(1);
    });

    it('后缀在 root 里没有升格：不取分片、不下整表，id 原样', async () => {
        const calls = mockFetch();
        const item = await (await fresh()).createCosStorage().getItem(OTHER);
        expect(item).toMatchObject({ id: OTHER });
        expect((item as Record<string, unknown>).redirected_from).toBeUndefined();
        expect(calls.some(u => u.includes('/h1/promotions/'))).toBe(false);
        expect(calls.some(u => u.includes('/promotions.json'))).toBe(false);
    });

    it('root 没有 promotionShards（较早的 root）：退回整张 promotions.json', async () => {
        const calls = mockFetch({ promotionShards: null });
        const item = await (await fresh()).createCosStorage().getItem(DRAFT);
        expect(item).toMatchObject({ id: PROD, redirected_from: DRAFT });
        expect(calls.some(u => u.includes('/promotions.json'))).toBe(true);
    });

    it('h1 指针取不到：退回整张 promotions.json', async () => {
        const calls = mockFetch({ pointerStatus: 503 });
        const item = await (await fresh()).createCosStorage().getItem(DRAFT);
        expect(item).toMatchObject({ id: PROD });
        expect(calls.some(u => u.includes('/promotions.json'))).toBe(true);
    });

    it('分片取不到：退回整张 promotions.json，不让重定向静默失效', async () => {
        const calls = mockFetch({ shardStatus: 500 });
        const item = await (await fresh()).createCosStorage().getItem(DRAFT);
        expect(item).toMatchObject({ id: PROD });
        expect(calls.some(u => u.includes('/promotions.json'))).toBe(true);
    });
});
