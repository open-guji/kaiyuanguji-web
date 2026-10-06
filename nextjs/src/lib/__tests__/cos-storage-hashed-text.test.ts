/**
 * cos-storage.ts 的 h1（内容哈希寻址）阅读文本取数路径单测（A3b 第二期；overview#307 起只认新结构 manifest.json＋<key>/）。
 *
 * 与 cos-storage-hashed.test.ts（entry 部分，A3 第一期）同一套写法：DATA_LAYOUT
 * 是模块级常量，每个用例用 jest.isolateModulesAsync 拿一份全新模块实例。
 *
 * 默认（未设置或非 'hashed'）时，getTextManifest／getTextIndex／getChapter 必须原样委托给 inner
 * （book-index-ui 的 BundleStorage），走它自己的现行 URL 拼法（`items/<id>/manifest.json` 等）。
 *
 * S3（h1 版本根清单，2026-09-27）：取数链路是「指针→root→分片→文件」四级，mock 链路照这个顺序，
 * 详见 cos-storage-hashed.test.ts 头部注释（entry 侧同一次改造）。
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
const ROOT_KEY = 'troot1';

function jsonResponse(body: unknown, ok = true, status = 200) {
    return { ok, status, json: async () => body, text: async () => JSON.stringify(body) } as Response;
}
function textResponse(body: string, ok = true, status = 200) {
    return { ok, status, text: async () => body } as Response;
}
function pointerResponse(root = ROOT_KEY) {
    return jsonResponse({ version: 2, root: `${root}.json`, generatedAt: 'x', dataCommit: {} });
}
function rootDocResponse(shardKeyLength: number, shards: Record<string, string>) {
    return jsonResponse({
        version: 1, shardKeyLength, shardSpace: 1296, shardCount: Object.keys(shards).length,
        ownerCount: 0, fileCount: 0, generatedAt: 'x', dataCommit: {}, shards,
    });
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

describe('cos-storage：h1 哈希寻址路径（指针／分片异常）', () => {
    let originalFetch: typeof fetch;
    beforeEach(() => { originalFetch = global.fetch; });
    afterEach(() => { global.fetch = originalFetch; });

    it('hashed：root 里没有这个 owner 所在的分片 → 返回 null，不抛错', async () => {
        global.fetch = jest.fn().mockImplementation(async (url: string) => {
            if (url.endsWith('/h1/text-manifest-root.json')) return pointerResponse();
            if (url.endsWith(`/h1/text-roots/${ROOT_KEY}.json`)) return rootDocResponse(2, {}); // 空 root：任何分片都不存在
            throw new Error(`unexpected fetch: ${url}`);
        }) as unknown as typeof fetch;

        const { createCosStorage } = await freshCosStorage({ layout: 'hashed' });
        const storage = createCosStorage();
        expect(await storage.getTextManifest?.(BOOK_ID)).toBeNull();
    });

    it('hashed：分片里没有这个 owner/相对路径（分片存在但未命中）→ 返回 null，不抛错', async () => {
        const shardHash = 'shard-b2';
        global.fetch = jest.fn().mockImplementation(async (url: string) => {
            if (url.endsWith('/h1/text-manifest-root.json')) return pointerResponse();
            if (url.endsWith(`/h1/text-roots/${ROOT_KEY}.json`)) return rootDocResponse(2, { [BOOK_SHARD]: shardHash });
            if (url.endsWith(`/h1/text-manifest/${BOOK_SHARD}.${shardHash}.json`)) return jsonResponse({}); // 空分片
            throw new Error(`unexpected fetch: ${url}`);
        }) as unknown as typeof fetch;

        const { createCosStorage } = await freshCosStorage({ layout: 'hashed' });
        const storage = createCosStorage();
        expect(await storage.getTextManifest?.(BOOK_ID)).toBeNull();
    });

    it('hashed：指针翻转到新版，文件 404 → 清指针+root 缓存重取后成功', async () => {
        const staleHash = 'aaaaaaaa';
        const freshHash = 'bbbbbbbb';
        const staleRoot = 'troot-old';
        const freshRoot = 'troot-new';
        let pointerFetchCount = 0;
        let currentPointerRoot = staleRoot;

        global.fetch = jest.fn().mockImplementation(async (url: string) => {
            if (url.endsWith('/h1/text-manifest-root.json')) {
                pointerFetchCount++;
                const root = currentPointerRoot;
                currentPointerRoot = freshRoot;
                return pointerResponse(root);
            }
            if (url.endsWith(`/h1/text-roots/${staleRoot}.json`)) return rootDocResponse(2, { [BOOK_SHARD]: 'shard-old' });
            if (url.endsWith(`/h1/text-roots/${freshRoot}.json`)) return rootDocResponse(2, { [BOOK_SHARD]: 'shard-new' });
            if (url.endsWith(`/h1/text-manifest/${BOOK_SHARD}.shard-old.json`)) return jsonResponse({ [BOOK_ID]: { 'manifest.json': staleHash } });
            if (url.endsWith(`/h1/text-manifest/${BOOK_SHARD}.shard-new.json`)) return jsonResponse({ [BOOK_ID]: { 'manifest.json': freshHash } });
            if (url.endsWith(`/h1/text/${BOOK_ID}/manifest.${staleHash}.json`)) return jsonResponse({}, false, 404);
            if (url.endsWith(`/h1/text/${BOOK_ID}/manifest.${freshHash}.json`)) return jsonResponse({ id: BOOK_ID, versions: [], refreshed: true });
            throw new Error(`unexpected fetch: ${url}`);
        }) as unknown as typeof fetch;

        const { createCosStorage } = await freshCosStorage({ layout: 'hashed' });
        const storage = createCosStorage();
        const result = await storage.getTextManifest?.(BOOK_ID);

        expect(result).toMatchObject({ refreshed: true });
        expect(pointerFetchCount).toBe(2);
    });
});

describe('cos-storage：h1 哈希寻址路径（阅读文本新结构，overview#307）', () => {
    let originalFetch: typeof fetch;
    beforeEach(() => { originalFetch = global.fetch; });
    afterEach(() => { global.fetch = originalFetch; });

    const manifest = { id: WORK_ID, versions: [{ key: 'default', kind: 'collated', label: '整理本' }] };
    const files: Record<string, { hash: string; body: unknown; text?: boolean }> = {
        'manifest.json': { hash: 'aaaaaaa1', body: manifest },
        'default/index.json': { hash: 'aaaaaaa2', body: { chapters: [{ n: 1, file: '001', title: '一', has_json: true }] } },
        'default/001.txt': { hash: 'aaaaaaa3', body: '# 一\n正文', text: true },
        'default/001.json': { hash: 'aaaaaaa4', body: { title: '一', sections: [] } },
    };
    const shardHash = 'shard-n1';

    function mockH1() {
        const calls: string[] = [];
        global.fetch = jest.fn().mockImplementation(async (url: string) => {
            calls.push(url);
            if (url.endsWith('/h1/text-manifest-root.json')) return pointerResponse();
            if (url.endsWith(`/h1/text-roots/${ROOT_KEY}.json`)) return rootDocResponse(2, { [WORK_SHARD]: shardHash });
            if (url.endsWith(`/h1/text-manifest/${WORK_SHARD}.${shardHash}.json`)) {
                return jsonResponse({ [WORK_ID]: Object.fromEntries(Object.entries(files).map(([rel, f]) => [rel, f.hash])) });
            }
            for (const [rel, f] of Object.entries(files)) {
                const i = rel.lastIndexOf('.');
                if (url.endsWith(`/h1/text/${WORK_ID}/${rel.slice(0, i)}.${f.hash}${rel.slice(i)}`)) return f.text ? textResponse(f.body as string) : jsonResponse(f.body);
            }
            throw new Error(`unexpected fetch: ${url}`);
        }) as unknown as typeof fetch;
        return calls;
    }

    it('hashed：getTextManifest／getTextIndex／getChapter 走 h1 路径（manifest.json、<key>/index.json、<key>/NNN.txt、NNN.json）', async () => {
        const calls = mockH1();
        const { createCosStorage } = await freshCosStorage({ layout: 'hashed' });
        const storage = createCosStorage();
        expect(await storage.getTextManifest?.(WORK_ID)).toMatchObject({ id: WORK_ID });
        expect((await storage.getTextIndex?.(WORK_ID, 'default'))?.chapters).toHaveLength(1);
        const both = await storage.getChapter?.(WORK_ID, 'default', '001', { json: true });
        expect(both?.md).toBe('# 一\n正文');
        expect(both?.json).toMatchObject({ title: '一' });
        const mdOnly = await storage.getChapter?.(WORK_ID, 'default', '001');
        expect(mdOnly).toEqual({ md: '# 一\n正文', json: null });
        expect(calls.some(u => u.includes('/current/'))).toBe(false);
    });

    it('hashed：没有这个文件 → null；key／章不合法 → null 且不发 h1 请求', async () => {
        const calls = mockH1();
        const { createCosStorage } = await freshCosStorage({ layout: 'hashed' });
        const storage = createCosStorage();
        expect(await storage.getTextIndex?.(WORK_ID, 'wikisource')).toBeNull(); // manifest 分片里没有这一项
        const before = calls.length;
        for (const key of ['../x', 'a/b', 'manifest', '001', 'Wiki']) expect(await storage.getTextIndex?.(WORK_ID, key)).toBeNull();
        expect(await storage.getChapter?.(WORK_ID, 'default', '../001')).toBeNull();
        expect(await storage.getChapter?.(WORK_ID, 'default', '001?x=1')).toBeNull();
        expect(await storage.getTextManifest?.('../x')).toBeNull();
        expect(calls.length).toBe(before);
    });

    it('不设置开关：三个方法原样委托给 inner（BundleStorage，current/items/…），一次不碰 h1/', async () => {
        // jsdom 没有 AbortSignal.timeout，BundleStorage 取数前就抛了（返回 null）：补一个，才看得到它真的发了请求
        const as = AbortSignal as unknown as { timeout?: (ms: number) => AbortSignal };
        if (!as.timeout) as.timeout = () => new AbortController().signal;
        const calls: string[] = [];
        global.fetch = jest.fn().mockImplementation(async (url: string) => {
            calls.push(url);
            if (url.endsWith('/latest.json') || url.endsWith('/version.json')) return jsonResponse({ commitId: 'legacycommit123456' });
            if (url.includes('/items/') && url.includes('/manifest.json')) return jsonResponse(manifest);
            return jsonResponse({}, false, 404);
        }) as unknown as typeof fetch;
        const { createCosStorage } = await freshCosStorage({ layout: undefined });
        const storage = createCosStorage();
        expect(await storage.getTextManifest?.(WORK_ID)).toMatchObject({ id: WORK_ID });
        expect(calls.some(u => u.includes(`/current/items/${WORK_ID}/manifest.json`))).toBe(true);
        expect(calls.some(u => u.includes('/h1/'))).toBe(false);
    });
});

describe('cos-storage：对读数据文件 getTextFile（overview#421：线上文本在 h1 哈希寻址里，同域 /data/items 是 404）', () => {
    let originalFetch: typeof fetch;
    beforeEach(() => { originalFetch = global.fetch; });
    afterEach(() => { global.fetch = originalFetch; });

    type TextFileApi = { getTextFile: (id: string, key: string, file: string) => Promise<unknown> };
    const files: Record<string, { hash: string; body: unknown }> = {
        'original/003.char.json': { hash: 'bbbbbbb1', body: { pages: [] } },
        'original/003.cord.json': { hash: 'bbbbbbb2', body: { pages: [] } },
        'original/003.entity.json': { hash: 'bbbbbbb3', body: { entities: [] } },
    };
    const shardHash = 'shard-d1';

    function mockH1() {
        const calls: string[] = [];
        global.fetch = jest.fn().mockImplementation(async (url: string) => {
            calls.push(url);
            if (url.endsWith('/h1/text-manifest-root.json')) return pointerResponse();
            if (url.endsWith(`/h1/text-roots/${ROOT_KEY}.json`)) return rootDocResponse(2, { [BOOK_SHARD]: shardHash });
            if (url.endsWith(`/h1/text-manifest/${BOOK_SHARD}.${shardHash}.json`)) {
                return jsonResponse({ [BOOK_ID]: Object.fromEntries(Object.entries(files).map(([rel, f]) => [rel, f.hash])) });
            }
            for (const [rel, f] of Object.entries(files)) {
                const i = rel.lastIndexOf('.');
                if (url.endsWith(`/h1/text/${BOOK_ID}/${rel.slice(0, i)}.${f.hash}${rel.slice(i)}`)) return jsonResponse(f.body);
            }
            throw new Error(`unexpected fetch: ${url}`);
        }) as unknown as typeof fetch;
        return calls;
    }

    it('hashed：请求的是哈希路径 text/<id>/<版本>/<文件名.hash8.json>，不碰 /data/items', async () => {
        const calls = mockH1();
        const { createCosStorage } = await freshCosStorage({ layout: 'hashed' });
        const storage = createCosStorage() as unknown as TextFileApi;
        expect(await storage.getTextFile(BOOK_ID, 'original', '003.char.json')).toEqual({ pages: [] });
        expect(await storage.getTextFile(BOOK_ID, 'original', '003.entity.json')).toEqual({ entities: [] });
        expect(calls).toContain(`${COS_BASE}/h1/text/${BOOK_ID}/original/003.char.bbbbbbb1.json`);
        expect(calls).toContain(`${COS_BASE}/h1/text/${BOOK_ID}/original/003.entity.bbbbbbb3.json`);
        expect(calls.some(u => u.includes('/data/items/') || u.includes('/current/'))).toBe(false);
    });

    it('hashed：清单里没有这个文件 → null；文件名／key 不合法 → null 且不发请求', async () => {
        const calls = mockH1();
        const { createCosStorage } = await freshCosStorage({ layout: 'hashed' });
        const storage = createCosStorage() as unknown as TextFileApi;
        expect(await storage.getTextFile(BOOK_ID, 'original', '003.punct.json')).toBeNull();
        const before = calls.length;
        for (const f of ['../index.json', 'a/b.json', '003.char.json?x=1', '..', '']) expect(await storage.getTextFile(BOOK_ID, 'original', f)).toBeNull();
        expect(await storage.getTextFile(BOOK_ID, '../x', '003.char.json')).toBeNull();
        expect(await storage.getTextFile('../x', 'original', '003.char.json')).toBeNull();
        expect(calls.length).toBe(before);
    });

    it('不设置开关：走现行 current/items/<id>/<版本>/<文件>?v=<版本号>，一次不碰 h1/', async () => {
        const calls: string[] = [];
        global.fetch = jest.fn().mockImplementation(async (url: string) => {
            calls.push(url);
            if (url.endsWith('/latest.json') || url.endsWith('/version.json')) return jsonResponse({ commitId: 'legacycommit123456' });
            if (url.includes(`/items/${BOOK_ID}/original/003.cord.json`)) return jsonResponse({ pages: [1] });
            return jsonResponse({}, false, 404);
        }) as unknown as typeof fetch;
        const { createCosStorage } = await freshCosStorage({ layout: undefined });
        const storage = createCosStorage() as unknown as TextFileApi;
        expect(await storage.getTextFile(BOOK_ID, 'original', '003.cord.json')).toEqual({ pages: [1] });
        expect(calls.some(u => u.includes(`/current/items/${BOOK_ID}/original/003.cord.json?v=`))).toBe(true);
        expect(calls.some(u => u.includes('/h1/'))).toBe(false);
        expect(await storage.getTextFile(BOOK_ID, 'original', '003.missing.json')).toBeNull();
    });
});
