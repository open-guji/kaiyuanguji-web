/**
 * cos-storage.ts 的 h1（内容哈希寻址）取数路径单测。
 *
 * A3 第一期的完成判据要求「开关关闭时，构建产物与线上行为与 main 完全一致」——
 * 这里对应的是：不设置 / 设置为非 'hashed' 的任何值时，一律走现行 current/ 路径，
 * 半点不碰新代码。而开关打开时，两条路径对同一份原始 detail 字节要拼出
 * 完全相同的 IndexEntry（getEntry）与原始 detail（getItem），保证前端渲染的
 * 内容逐字一致——这正是任务书判据 2「20 条内容比对」在单测层面的对应验证。
 *
 * DATA_LAYOUT / COS_BASE 都是模块级常量，在 import 时按 process.env 解析一次，
 * 所以每个用例都要 jest.isolateModulesAsync 拿一份全新模块实例。
 */
import { jest } from '@jest/globals';

// error-report 有 sendBeacon/fetch 兜底与去重表等副作用，与本文件要测的行为无关，
// 整体 mock 掉，只关心「404 时确实调用了 reportError」这一件事。
jest.mock('../error-report', () => ({
    reportError: jest.fn(),
    setRelease: jest.fn(),
}));

const COS_BASE = 'https://data.example.com';

// 真实存在的样本 id（从 book-index 生产库里挑的，type 位能被 extractType 正确解出）：
// 两个 book id 故意同后缀（'10'），用来验证 manifest 分片的内存缓存只拉一次。
const BOOK_ID_A = '988fz1pb10';
const BOOK_ID_B = '988fzcmm10';
const WORK_ID = 'd59df01avcw0';
const SHARD_KEY = '10'; // BOOK_ID_A / BOOK_ID_B 的分片键

function jsonResponse(body: unknown, ok = true, status = 200) {
    return {
        ok,
        status,
        json: async () => body,
    } as Response;
}

async function freshCosStorage(env: { layout?: string; cosBase?: string }) {
    const prevLayout = process.env.NEXT_PUBLIC_DATA_LAYOUT;
    const prevBase = process.env.NEXT_PUBLIC_COS_BASE;
    if (env.layout === undefined) delete process.env.NEXT_PUBLIC_DATA_LAYOUT;
    else process.env.NEXT_PUBLIC_DATA_LAYOUT = env.layout;
    process.env.NEXT_PUBLIC_COS_BASE = env.cosBase ?? COS_BASE;

    let mod!: typeof import('../cos-storage');
    await jest.isolateModulesAsync(async () => {
        mod = await import('../cos-storage');
    });

    if (prevLayout === undefined) delete process.env.NEXT_PUBLIC_DATA_LAYOUT;
    else process.env.NEXT_PUBLIC_DATA_LAYOUT = prevLayout;
    if (prevBase === undefined) delete process.env.NEXT_PUBLIC_COS_BASE;
    else process.env.NEXT_PUBLIC_COS_BASE = prevBase;

    return mod;
}

describe('cos-storage：h1 哈希寻址路径（开关）', () => {
    let originalFetch: typeof fetch;
    beforeEach(() => {
        originalFetch = global.fetch;
        jest.clearAllMocks();
    });
    afterEach(() => {
        global.fetch = originalFetch;
    });

    it('不设置 NEXT_PUBLIC_DATA_LAYOUT：走现行 current/ 路径，一次不碰 h1/', async () => {
        const detail = { id: WORK_ID, title: '尚書正義', author: '孔穎達' };
        const calls: string[] = [];
        global.fetch = jest.fn().mockImplementation(async (url: string) => {
            calls.push(url);
            if (url.endsWith('/latest.json')) return jsonResponse({ commitId: 'legacycommit1' });
            if (url.includes('/promotions.json')) return jsonResponse({ version: 1, promotions: {} });
            if (url.includes(`/current/entry/${WORK_ID}.json`)) return jsonResponse(detail);
            throw new Error(`unexpected fetch: ${url}`);
        }) as unknown as typeof fetch;

        const { createCosStorage } = await freshCosStorage({ layout: undefined });
        const storage = createCosStorage();
        const item = await storage.getItem(WORK_ID);

        expect(item).toMatchObject({ id: WORK_ID, title: '尚書正義' });
        expect(calls.some(u => u.includes('/current/entry/'))).toBe(true);
        expect(calls.some(u => u.includes('/h1/'))).toBe(false);
    });

    it("NEXT_PUBLIC_DATA_LAYOUT 设成非 'hashed' 的值（如历史遗留的 'legacy'）：仍走现行路径", async () => {
        const detail = { id: WORK_ID, title: '尚書正義' };
        global.fetch = jest.fn().mockImplementation(async (url: string) => {
            if (url.endsWith('/latest.json')) return jsonResponse({ commitId: 'c1' });
            if (url.includes('/promotions.json')) return jsonResponse({ version: 1, promotions: {} });
            if (url.includes(`/current/entry/${WORK_ID}.json`)) return jsonResponse(detail);
            throw new Error(`unexpected fetch: ${url}`);
        }) as unknown as typeof fetch;

        const { createCosStorage } = await freshCosStorage({ layout: 'legacy' });
        const storage = createCosStorage();
        const item = await storage.getItem(WORK_ID);
        expect(item).toMatchObject({ title: '尚書正義' });
    });

    it("NEXT_PUBLIC_DATA_LAYOUT=hashed：读 manifest-root → 读分片 → 取 entry", async () => {
        const detailA = { id: BOOK_ID_A, title: '甲书', author: '甲' };
        const hashA = 'aaaaaaaa';
        const manifestShard: Record<string, string> = { [BOOK_ID_A]: hashA };

        const calls: string[] = [];
        global.fetch = jest.fn().mockImplementation(async (url: string) => {
            calls.push(url);
            // promotions.json 不在 h1 范围内，仍走现行 current/latest.json 基础设施
            // （见 fetchRawDetailH1 上方注释）——这两个 mock 分支代表的正是这件事，
            // 不代表「hashed 模式漏走了 legacy 路径」。
            if (url.endsWith('/latest.json')) return jsonResponse({ commitId: 'legacycommit1' });
            if (url.endsWith('/promotions.json')) return jsonResponse({ version: 1, promotions: {} });
            if (url.endsWith('/h1/manifest-root.json')) {
                return jsonResponse({
                    shardKeyLength: 2, shardSpace: 1296, shardCount: 1,
                    generatedAt: '2026-09-26T00:00:00.000Z',
                    dataCommit: { commitId: 'c1', productionCommitId: 'c2', textCommitId: 'c3' },
                });
            }
            if (url.endsWith(`/h1/manifest/${SHARD_KEY}.json`)) return jsonResponse(manifestShard);
            if (url.endsWith(`/h1/entry/${BOOK_ID_A}.${hashA}.json`)) return jsonResponse(detailA);
            throw new Error(`unexpected fetch: ${url}`);
        }) as unknown as typeof fetch;

        const { createCosStorage } = await freshCosStorage({ layout: 'hashed' });
        const storage = createCosStorage();

        const entry = await storage.getEntry(BOOK_ID_A);
        expect(entry).toMatchObject({ id: BOOK_ID_A, title: '甲书', type: 'book', author: '甲' });

        const item = await storage.getItem(BOOK_ID_A);
        expect(item).toMatchObject({ id: BOOK_ID_A, title: '甲书' });

        // 条目本身（entry）一律不走现行 current/entry 路径——这才是本条要钉住的事
        expect(calls.some(u => u.includes('/current/entry/'))).toBe(false);
        expect(calls.some(u => u.includes('/h1/entry/'))).toBe(true);
    });

    it('hashed：同一分片内第二个 id 复用内存缓存，manifest 分片只拉一次', async () => {
        const hashA = 'aaaaaaaa';
        const hashB = 'bbbbbbbb';
        const manifestShard: Record<string, string> = { [BOOK_ID_A]: hashA, [BOOK_ID_B]: hashB };

        let manifestFetchCount = 0;
        global.fetch = jest.fn().mockImplementation(async (url: string) => {
            if (url.endsWith('/promotions.json')) return jsonResponse({ version: 1, promotions: {} });
            if (url.endsWith('/h1/manifest-root.json')) {
                return jsonResponse({ shardKeyLength: 2, shardSpace: 1296, shardCount: 1, generatedAt: 'x', dataCommit: {} });
            }
            if (url.endsWith(`/h1/manifest/${SHARD_KEY}.json`)) {
                manifestFetchCount++;
                return jsonResponse(manifestShard);
            }
            if (url.endsWith(`/h1/entry/${BOOK_ID_A}.${hashA}.json`)) return jsonResponse({ id: BOOK_ID_A, title: '甲书' });
            if (url.endsWith(`/h1/entry/${BOOK_ID_B}.${hashB}.json`)) return jsonResponse({ id: BOOK_ID_B, title: '乙书' });
            throw new Error(`unexpected fetch: ${url}`);
        }) as unknown as typeof fetch;

        const { createCosStorage } = await freshCosStorage({ layout: 'hashed' });
        const storage = createCosStorage();

        const a = await storage.getItem(BOOK_ID_A);
        const b = await storage.getItem(BOOK_ID_B);

        expect(a).toMatchObject({ title: '甲书' });
        expect(b).toMatchObject({ title: '乙书' });
        expect(manifestFetchCount).toBe(1); // 同分片，第二次命中内存缓存
    });

    it('hashed：id 不在任何分片里（manifest 未命中）→ 视同 404，返回 null，上报一次', async () => {
        const { reportError } = await import('../error-report');
        global.fetch = jest.fn().mockImplementation(async (url: string) => {
            if (url.endsWith('/promotions.json')) return jsonResponse({ version: 1, promotions: {} });
            if (url.endsWith('/h1/manifest-root.json')) {
                return jsonResponse({ shardKeyLength: 2, shardSpace: 1296, shardCount: 0, generatedAt: 'x', dataCommit: {} });
            }
            if (url.endsWith(`/h1/manifest/${SHARD_KEY}.json`)) return jsonResponse({}); // 空分片
            throw new Error(`unexpected fetch: ${url}`);
        }) as unknown as typeof fetch;

        const { createCosStorage } = await freshCosStorage({ layout: 'hashed' });
        const storage = createCosStorage();
        const item = await storage.getItem(BOOK_ID_A);

        expect(item).toBeNull();
        expect(reportError).toHaveBeenCalledWith(expect.objectContaining({ status: 404, resource: BOOK_ID_A }));
    });

    it('hashed：分片过期指向已不存在的旧哈希，entry 404 → 清缓存重取分片后成功', async () => {
        // 模拟场景（协调者验收第二轮 item 3）：页面内存里的分片缓存是旧的，
        // 指向的 hash 对应的 entry 文件已经不在（无论是因为 sync 端保留期外
        // 被清掉，还是分片本身滞后于 entry 的实际最新状态），第一次按旧 hash
        // 取 entry 会 404；加固逻辑应当清掉分片缓存、重新解析出新 hash，再取一次。
        const staleHash = 'aaaaaaaa';
        const freshHash = 'bbbbbbbb';
        let shardFetchCount = 0;
        let currentShardHash = staleHash; // 第一次 fetch 分片时返回旧值，之后返回新值

        global.fetch = jest.fn().mockImplementation(async (url: string) => {
            if (url.endsWith('/promotions.json')) return jsonResponse({ version: 1, promotions: {} });
            if (url.endsWith('/h1/manifest-root.json')) {
                return jsonResponse({ shardKeyLength: 2, shardSpace: 1296, shardCount: 1, generatedAt: 'x', dataCommit: {} });
            }
            if (url.endsWith(`/h1/manifest/${SHARD_KEY}.json`)) {
                shardFetchCount++;
                const hashToReturn = currentShardHash;
                currentShardHash = freshHash; // 下一次（重取）返回新值，模拟分片已经更新
                return jsonResponse({ [BOOK_ID_A]: hashToReturn });
            }
            if (url.endsWith(`/h1/entry/${BOOK_ID_A}.${staleHash}.json`)) {
                return jsonResponse({}, false, 404);
            }
            if (url.endsWith(`/h1/entry/${BOOK_ID_A}.${freshHash}.json`)) {
                return jsonResponse({ id: BOOK_ID_A, title: '甲书（新版）' });
            }
            throw new Error(`unexpected fetch: ${url}`);
        }) as unknown as typeof fetch;

        const { createCosStorage } = await freshCosStorage({ layout: 'hashed' });
        const storage = createCosStorage();
        const item = await storage.getItem(BOOK_ID_A);

        expect(item).toMatchObject({ title: '甲书（新版）' });
        expect(shardFetchCount).toBe(2); // 第一次拿旧值，404 后清缓存重取一次拿到新值
    });

    it('hashed：分片过期但重取后 hash 未变（entry 就是真 404）→ 不再重试，返回 null', async () => {
        const hash = 'aaaaaaaa';
        let shardFetchCount = 0;
        global.fetch = jest.fn().mockImplementation(async (url: string) => {
            if (url.endsWith('/promotions.json')) return jsonResponse({ version: 1, promotions: {} });
            if (url.endsWith('/h1/manifest-root.json')) {
                return jsonResponse({ shardKeyLength: 2, shardSpace: 1296, shardCount: 1, generatedAt: 'x', dataCommit: {} });
            }
            if (url.endsWith(`/h1/manifest/${SHARD_KEY}.json`)) {
                shardFetchCount++;
                return jsonResponse({ [BOOK_ID_A]: hash }); // 重取也还是同一个 hash
            }
            if (url.endsWith(`/h1/entry/${BOOK_ID_A}.${hash}.json`)) return jsonResponse({}, false, 404);
            throw new Error(`unexpected fetch: ${url}`);
        }) as unknown as typeof fetch;

        const { createCosStorage } = await freshCosStorage({ layout: 'hashed' });
        const storage = createCosStorage();
        const item = await storage.getItem(BOOK_ID_A);

        expect(item).toBeNull();
        expect(shardFetchCount).toBe(2); // 确实重取了一次，但 hash 没变就不再多打一次 entry 请求
    });

    it('两条路径对同一份原始 detail 字节，拼出完全相同的 getEntry 结果（内容逐字一致）', async () => {
        const rawDetail = {
            id: WORK_ID, title: '尚書正義', author: '孔穎達', dynasty: '唐',
            _path: 'Work/d/5/9/d59df01avcw0-尚書正義.json', _isDraft: false,
        };
        const legacyCommit = 'legacycommit1';
        const h1Hash = 'deadbeef';

        global.fetch = jest.fn().mockImplementation(async (url: string) => {
            if (url.endsWith('/latest.json')) return jsonResponse({ commitId: legacyCommit });
            if (url.includes('/promotions.json')) return jsonResponse({ version: 1, promotions: {} });
            if (url.includes(`/current/entry/${WORK_ID}.json`)) return jsonResponse(rawDetail);
            if (url.endsWith('/h1/manifest-root.json')) {
                return jsonResponse({ shardKeyLength: 2, shardSpace: 1296, shardCount: 1, generatedAt: 'x', dataCommit: {} });
            }
            if (url.endsWith(`/h1/manifest/${WORK_ID.slice(-2)}.json`)) return jsonResponse({ [WORK_ID]: h1Hash });
            if (url.endsWith(`/h1/entry/${WORK_ID}.${h1Hash}.json`)) return jsonResponse(rawDetail);
            throw new Error(`unexpected fetch: ${url}`);
        }) as unknown as typeof fetch;

        const legacyMod = await freshCosStorage({ layout: undefined });
        const legacyEntry = await legacyMod.createCosStorage().getEntry(WORK_ID);

        const hashedMod = await freshCosStorage({ layout: 'hashed' });
        const hashedEntry = await hashedMod.createCosStorage().getEntry(WORK_ID);

        expect(hashedEntry).toEqual(legacyEntry);
    });
});
