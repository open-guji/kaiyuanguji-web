/**
 * cos-storage.ts 的 h1（内容哈希寻址）整理本／全文取数路径单测（A3b 第二期）。
 *
 * 与 cos-storage-hashed.test.ts（entry 部分，A3 第一期）同一套写法：DATA_LAYOUT
 * 是模块级常量，每个用例用 jest.isolateModulesAsync 拿一份全新模块实例。
 *
 * 完成判据要求「开关关闭时行为与 main 完全一致」——默认（未设置或非 'hashed'）
 * 时，getCollatedEditionIndex 等五个方法必须原样委托给 inner（book-index-ui 的
 * BundleStorage），走它自己的现行 URL 拼法（`items/<id>/collated_edition/…`
 * 等），本文件不碰、不改 bim/ui 一行代码——这里验证的正是「没有碰」。
 */
import { jest } from '@jest/globals';

jest.mock('../error-report', () => ({
    reportError: jest.fn(),
    setRelease: jest.fn(),
}));

const COS_BASE = 'https://data.example.com';
const WORK_ID = 'd59f2mp12329';
const BOOK_ID = '96kzkdm8e8';
const WORK_SHARD = WORK_ID.slice(-2);
const BOOK_SHARD = BOOK_ID.slice(-2);

function jsonResponse(body: unknown, ok = true, status = 200) {
    return { ok, status, json: async () => body, text: async () => JSON.stringify(body) } as Response;
}
function textResponse(body: string, ok = true, status = 200) {
    return { ok, status, text: async () => body } as Response;
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

describe('cos-storage：h1 哈希寻址路径（整理本／全文，开关）', () => {
    let originalFetch: typeof fetch;
    beforeEach(() => {
        originalFetch = global.fetch;
        jest.clearAllMocks();
    });
    afterEach(() => {
        global.fetch = originalFetch;
    });

    // 不设置开关时，cos-storage.ts 对这五个方法完全不特殊处理，原样委托给
    // inner（book-index-ui 的 BundleStorage，本道不改）——这里只验证「委托
    // 本身没被我的改动碰过」：与直接调用同一份 inner 实例、同一份 mock fetch
    // 相比，结果必须逐字一致，且全程不出现任何 `/h1/` 请求。inner 自身的取数
    // 逻辑对不对是 bim/ui 的测试范围，不是本文件要证明的事。
    it('不设置 NEXT_PUBLIC_DATA_LAYOUT：getCollatedJuan 原样委托给 inner，一次不碰 h1/', async () => {
        const juan = { title: '卷一', sections: [] };
        const calls: string[] = [];
        global.fetch = jest.fn().mockImplementation(async (url: string) => {
            calls.push(url);
            if (url.endsWith('/latest.json')) return jsonResponse({ commitId: 'legacycommit123456' });
            if (url.endsWith('/version.json')) return jsonResponse({ commitId: 'legacycommit123456' });
            return jsonResponse(juan);
        }) as unknown as typeof fetch;

        const { createCosStorage } = await freshCosStorage({ layout: undefined });
        const storage = createCosStorage();
        const result = await storage.getCollatedJuan?.(WORK_ID, 'juan/001.json');

        const { BundleStorage } = await import('book-index-ui/storage');
        const directInner = new BundleStorage({ basePath: `${COS_BASE}/current`, version: 'legacycommit123456' });
        const directResult = await directInner.getCollatedJuan(WORK_ID, 'juan/001.json');

        expect(result).toEqual(directResult);
        expect(calls.some(u => u.includes('/h1/'))).toBe(false);
    });

    it("NEXT_PUBLIC_DATA_LAYOUT=hashed：getCollatedJuan 读 text-manifest-root → 读分片 → 取文件", async () => {
        const juan = { title: '卷一', sections: [{ title: 's', type: 'text' }] };
        const hash = 'aaaaaaaa';
        const shard = { [WORK_ID]: { 'collated_edition/juan/001.json': hash } };

        const calls: string[] = [];
        global.fetch = jest.fn().mockImplementation(async (url: string) => {
            calls.push(url);
            if (url.endsWith('/h1/text-manifest-root.json')) {
                return jsonResponse({ shardKeyLength: 2, shardSpace: 1296, shardCount: 1, ownerCount: 1, fileCount: 1, generatedAt: 'x', dataCommit: {} });
            }
            if (url.endsWith(`/h1/text-manifest/${WORK_SHARD}.json`)) return jsonResponse(shard);
            if (url.endsWith(`/h1/text/${WORK_ID}/collated_edition/juan/001.${hash}.json`)) return jsonResponse(juan);
            throw new Error(`unexpected fetch: ${url}`);
        }) as unknown as typeof fetch;

        const { createCosStorage } = await freshCosStorage({ layout: 'hashed' });
        const storage = createCosStorage();
        const result = await storage.getCollatedJuan?.(WORK_ID, 'juan/001.json');

        expect(result).toMatchObject({ title: '卷一' });
        expect(calls.some(u => u.includes('/current/'))).toBe(false);
        expect(calls.some(u => u.includes('/h1/text/'))).toBe(true);
    });

    it('hashed：getCollatedJuanText 把 .json 换成 .txt，读 collated_edition/text/ 下的原文', async () => {
        const raw = '# 卷一\n\n正文……';
        const hash = 'bbbbbbbb';
        const shard = { [WORK_ID]: { 'collated_edition/text/juan/001.txt': hash } };

        global.fetch = jest.fn().mockImplementation(async (url: string) => {
            if (url.endsWith('/h1/text-manifest-root.json')) {
                return jsonResponse({ shardKeyLength: 2, shardSpace: 1296, shardCount: 1, ownerCount: 1, fileCount: 1, generatedAt: 'x', dataCommit: {} });
            }
            if (url.endsWith(`/h1/text-manifest/${WORK_SHARD}.json`)) return jsonResponse(shard);
            if (url.endsWith(`/h1/text/${WORK_ID}/collated_edition/text/juan/001.${hash}.txt`)) return textResponse(raw);
            throw new Error(`unexpected fetch: ${url}`);
        }) as unknown as typeof fetch;

        const { createCosStorage } = await freshCosStorage({ layout: 'hashed' });
        const storage = createCosStorage();
        const result = await storage.getCollatedJuanText?.(WORK_ID, 'juan/001.json');

        expect(result).toBe(raw);
    });

    it('hashed：getCollatedEditionIndex 主文件名 index.json 命中，不再试旧命名兜底', async () => {
        const idx = { work_id: WORK_ID, juan_files: ['juan/001.json'] };
        const hash = 'cccccccc';
        const shard = { [WORK_ID]: { 'collated_edition/index.json': hash } };
        let fallbackFetched = false;

        global.fetch = jest.fn().mockImplementation(async (url: string) => {
            if (url.endsWith('/h1/text-manifest-root.json')) {
                return jsonResponse({ shardKeyLength: 2, shardSpace: 1296, shardCount: 1, ownerCount: 1, fileCount: 1, generatedAt: 'x', dataCommit: {} });
            }
            if (url.endsWith(`/h1/text-manifest/${WORK_SHARD}.json`)) return jsonResponse(shard);
            if (url.endsWith(`/h1/text/${WORK_ID}/collated_edition/index.${hash}.json`)) return jsonResponse(idx);
            if (url.includes('collated_edition_index')) { fallbackFetched = true; return jsonResponse({}, false, 404); }
            throw new Error(`unexpected fetch: ${url}`);
        }) as unknown as typeof fetch;

        const { createCosStorage } = await freshCosStorage({ layout: 'hashed' });
        const storage = createCosStorage();
        const result = await storage.getCollatedEditionIndex?.(WORK_ID);

        expect(result).toMatchObject({ work_id: WORK_ID });
        expect(fallbackFetched).toBe(false);
    });

    it('hashed：getCollatedEditionIndex 主文件名未命中 manifest → 试旧命名 collated_edition_index.json', async () => {
        const idx = { work_id: WORK_ID, legacy: true };
        const hash = 'dddddddd';
        // manifest 里只有旧命名这一个 key，没有 index.json
        const shard = { [WORK_ID]: { 'collated_edition/collated_edition_index.json': hash } };

        global.fetch = jest.fn().mockImplementation(async (url: string) => {
            if (url.endsWith('/h1/text-manifest-root.json')) {
                return jsonResponse({ shardKeyLength: 2, shardSpace: 1296, shardCount: 1, ownerCount: 1, fileCount: 1, generatedAt: 'x', dataCommit: {} });
            }
            if (url.endsWith(`/h1/text-manifest/${WORK_SHARD}.json`)) return jsonResponse(shard);
            if (url.endsWith(`/h1/text/${WORK_ID}/collated_edition/collated_edition_index.${hash}.json`)) return jsonResponse(idx);
            throw new Error(`unexpected fetch: ${url}`);
        }) as unknown as typeof fetch;

        const { createCosStorage } = await freshCosStorage({ layout: 'hashed' });
        const storage = createCosStorage();
        const result = await storage.getCollatedEditionIndex?.(WORK_ID);

        expect(result).toMatchObject({ legacy: true });
    });

    it('hashed：getBookFullTextIndex / getBookFullTextChapter（.md→.txt）都能正确取到', async () => {
        const idx = { book_id: BOOK_ID, total_chapters: 120 };
        const chapterText = '第一回　正文……';
        const hashIdx = 'eeeeeeee';
        const hashCh = 'ffffffff';
        const shard = {
            [BOOK_ID]: {
                'full_text/index.json': hashIdx,
                'full_text/001.txt': hashCh,
            },
        };

        global.fetch = jest.fn().mockImplementation(async (url: string) => {
            if (url.endsWith('/h1/text-manifest-root.json')) {
                return jsonResponse({ shardKeyLength: 2, shardSpace: 1296, shardCount: 1, ownerCount: 1, fileCount: 2, generatedAt: 'x', dataCommit: {} });
            }
            if (url.endsWith(`/h1/text-manifest/${BOOK_SHARD}.json`)) return jsonResponse(shard);
            if (url.endsWith(`/h1/text/${BOOK_ID}/full_text/index.${hashIdx}.json`)) return jsonResponse(idx);
            if (url.endsWith(`/h1/text/${BOOK_ID}/full_text/001.${hashCh}.txt`)) return textResponse(chapterText);
            throw new Error(`unexpected fetch: ${url}`);
        }) as unknown as typeof fetch;

        const { createCosStorage } = await freshCosStorage({ layout: 'hashed' });
        const storage = createCosStorage();

        const idxResult = await storage.getBookFullTextIndex?.(BOOK_ID);
        expect(idxResult).toMatchObject({ book_id: BOOK_ID });

        const chResult = await storage.getBookFullTextChapter?.(BOOK_ID, '001.md');
        expect(chResult).toBe(chapterText);
    });

    it('hashed：manifest 里没有这个 owner/相对路径 → 返回 null，不抛错', async () => {
        global.fetch = jest.fn().mockImplementation(async (url: string) => {
            if (url.endsWith('/h1/text-manifest-root.json')) {
                return jsonResponse({ shardKeyLength: 2, shardSpace: 1296, shardCount: 0, ownerCount: 0, fileCount: 0, generatedAt: 'x', dataCommit: {} });
            }
            if (url.endsWith(`/h1/text-manifest/${BOOK_SHARD}.json`)) return jsonResponse({}); // 空分片
            throw new Error(`unexpected fetch: ${url}`);
        }) as unknown as typeof fetch;

        const { createCosStorage } = await freshCosStorage({ layout: 'hashed' });
        const storage = createCosStorage();
        const result = await storage.getBookFullTextIndex?.(BOOK_ID);
        expect(result).toBeNull();
    });

    it('hashed：juanFile 含 ".." 或不以 .json 结尾 → 拒绝，不发起任何 h1 请求', async () => {
        const calls: string[] = [];
        global.fetch = jest.fn().mockImplementation(async (url: string) => {
            calls.push(url);
            throw new Error(`unexpected fetch: ${url}`);
        }) as unknown as typeof fetch;

        const { createCosStorage } = await freshCosStorage({ layout: 'hashed' });
        const storage = createCosStorage();

        expect(await storage.getCollatedJuan?.(WORK_ID, '../etc/passwd.json')).toBeNull();
        expect(await storage.getCollatedJuan?.(WORK_ID, 'juan/001.txt')).toBeNull();
        expect(await storage.getCollatedJuanText?.(WORK_ID, '../x.json')).toBeNull();
        expect(await storage.getBookFullTextChapter?.(BOOK_ID, '../x.md')).toBeNull();
        expect(calls.length).toBe(0);
    });

    it('hashed：分片过期指向已不存在的旧哈希，文件 404 → 清缓存重取分片后成功', async () => {
        const staleHash = 'aaaaaaaa';
        const freshHash = 'bbbbbbbb';
        let shardFetchCount = 0;
        let currentHash = staleHash;

        global.fetch = jest.fn().mockImplementation(async (url: string) => {
            if (url.endsWith('/h1/text-manifest-root.json')) {
                return jsonResponse({ shardKeyLength: 2, shardSpace: 1296, shardCount: 1, ownerCount: 1, fileCount: 1, generatedAt: 'x', dataCommit: {} });
            }
            if (url.endsWith(`/h1/text-manifest/${BOOK_SHARD}.json`)) {
                shardFetchCount++;
                const h = currentHash;
                currentHash = freshHash;
                return jsonResponse({ [BOOK_ID]: { 'full_text/index.json': h } });
            }
            if (url.endsWith(`/h1/text/${BOOK_ID}/full_text/index.${staleHash}.json`)) return jsonResponse({}, false, 404);
            if (url.endsWith(`/h1/text/${BOOK_ID}/full_text/index.${freshHash}.json`)) return jsonResponse({ book_id: BOOK_ID, refreshed: true });
            throw new Error(`unexpected fetch: ${url}`);
        }) as unknown as typeof fetch;

        const { createCosStorage } = await freshCosStorage({ layout: 'hashed' });
        const storage = createCosStorage();
        const result = await storage.getBookFullTextIndex?.(BOOK_ID);

        expect(result).toMatchObject({ refreshed: true });
        expect(shardFetchCount).toBe(2);
    });
});
