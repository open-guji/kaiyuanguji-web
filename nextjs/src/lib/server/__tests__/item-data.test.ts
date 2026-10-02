/**
 * @jest-environment node
 *
 * 条目页 SSR 服务端取数（W2-1）单测：h1 四级取数、各种读不到时回退 current/、
 * 临时故障不被当成 404、指针缓存与刷新。
 */
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { createItemFetcher, isValidItemId } from '../item-data';

// 回退时的 console.warn 是给线上排查看的，单测里静音
beforeEach(() => { jest.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => { jest.restoreAllMocks(); });
import { summarizeItem } from '../item-summary';

const BASE = 'https://data.example.com/staging';
const ID = 'd59f20aowb9c'; // 史記，分片键 '9c'
const ENTRY = { id: ID, type: 'work', title: '史記', authors: [{ name: '司馬遷', role: '撰', dynasty: '西漢' }] };

type Routes = Record<string, unknown | number>;

/** 按「去掉查询串的 URL」路由；值为数字表示返回该 HTTP 状态，'THROW' 表示网络错 */
function mockFetch(routes: Routes) {
    const calls: string[] = [];
    const fn = jest.fn(async (url: string) => {
        calls.push(url);
        const key = url.split('?')[0];
        if (!(key in routes)) return { ok: false, status: 404, json: async () => ({}) } as Response;
        const v = routes[key];
        if (v === 'THROW') throw new Error('network down');
        if (typeof v === 'number') return { ok: v < 400, status: v, json: async () => ({}) } as Response;
        return { ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(v)) } as Response;
    });
    return { fn, calls };
}

function h1Routes(entryHash = 'e1111111'): Routes {
    return {
        [`${BASE}/h1/manifest-root.json`]: { version: 2, root: 'r1.json' },
        [`${BASE}/h1/roots/r1.json`]: { shardKeyLength: 2, shards: { '9c': 's9c00000' } },
        [`${BASE}/h1/manifest/9c.s9c00000.json`]: { [ID]: entryHash },
        [`${BASE}/h1/entry/${ID}.${entryHash}.json`]: ENTRY,
    };
}

const currentRoutes: Routes = {
    [`${BASE}/latest.json`]: { commitId: 'abc123' },
    [`${BASE}/current/entry/${ID}.json`]: { ...ENTRY, title: '史記（current）' },
};

function make(routes: Routes, now = () => 1_000_000) {
    const { fn, calls } = mockFetch(routes);
    const f = createItemFetcher({ base: `${BASE}/`, fetch: fn as never, now, retryDelayMs: 0 });
    return { f, fn, calls };
}

describe('isValidItemId', () => {
    it.each(['d59f20aowb9c', '988g3gl3if', 'hixhd2f8wamg'])('合法 id：%s', (id) => {
        expect(isValidItemId(id)).toBe(true);
    });
    it.each(['', 'bad..id', '../etc', 'ABC123def', 'a/b', 'x'.repeat(30)])('非法 id：%s', (id) => {
        expect(isValidItemId(id)).toBe(false);
    });
});

describe('createItemFetcher.getItem', () => {
    it('h1 四级取数：指针 → root → 分片 → entry', async () => {
        const { f, calls } = make({ ...h1Routes(), ...currentRoutes });
        const r = await f.getItem(ID);
        expect(r).toEqual({ entry: ENTRY, source: 'h1', version: 'h1:r1.json' });
        expect(calls.map((u) => u.split('?')[0])).toEqual([
            `${BASE}/h1/manifest-root.json`,
            `${BASE}/h1/roots/r1.json`,
            `${BASE}/h1/manifest/9c.s9c00000.json`,
            `${BASE}/h1/entry/${ID}.e1111111.json`,
        ]);
        // 指针带按分钟取整的查询串（绕开 CDN 上的陈旧副本）
        expect(calls[0]).toMatch(/manifest-root\.json\?t=\d+$/);
    });

    it('非法 id 直接返回 null，一次请求都不发', async () => {
        const { f, fn } = make({ ...h1Routes(), ...currentRoutes });
        expect(await f.getItem('../x')).toBeNull();
        expect(fn).not.toHaveBeenCalled();
    });

    it('旧格式指针（无 root 字段）→ 回退 current/', async () => {
        const routes = { ...h1Routes(), ...currentRoutes, [`${BASE}/h1/manifest-root.json`]: { shardKeyLength: 2 } };
        const { f, calls } = make(routes);
        const r = await f.getItem(ID);
        expect(r?.source).toBe('current');
        expect(r?.entry.title).toBe('史記（current）');
        expect(r?.version).toBe('current:abc123');
        expect(calls).toContain(`${BASE}/current/entry/${ID}.json?v=abc123`);
    });

    it('latest.json 带 cacheKey → current/ 的 ?v= 用 cacheKey 而不是 commitId（overview#169）', async () => {
        const routes = { ...currentRoutes, [`${BASE}/latest.json`]: { commitId: 'abc123', cacheKey: 'k0123456789abcde' } };
        const { f, calls } = make(routes);
        const r = await f.getItem(ID);
        expect(r?.version).toBe('current:k0123456789abcde');
        expect(calls).toContain(`${BASE}/current/entry/${ID}.json?v=k0123456789abcde`);
    });

    it('h1 指针不存在（404）→ 回退 current/', async () => {
        const routes = { ...currentRoutes };
        const { f } = make(routes);
        expect((await f.getItem(ID))?.source).toBe('current');
    });

    it('h1 网络错 → 回退 current/', async () => {
        const routes = { ...h1Routes(), ...currentRoutes, [`${BASE}/h1/roots/r1.json`]: 'THROW' };
        const { f } = make(routes);
        expect((await f.getItem(ID))?.source).toBe('current');
    });

    it('分片里没有这个 id → 回退 current/；current/ 也没有 → null（页面出 404）', async () => {
        const routes = { ...h1Routes(), [`${BASE}/latest.json`]: { commitId: 'abc123' } };
        const { f, calls } = make(routes);
        expect(await f.getItem('d59f2zzzzz9c')).toBeNull();
        expect(calls.some((u) => u.includes('/current/entry/d59f2zzzzz9c.json'))).toBe(true);
    });

    it('current/ 回退路径 5xx → 抛错（临时故障不能当成 404 缓存到 CDN）', async () => {
        const routes = { [`${BASE}/latest.json`]: { commitId: 'abc123' }, [`${BASE}/current/entry/${ID}.json`]: 503 };
        const { f } = make(routes);
        await expect(f.getItem(ID)).rejects.toThrow(/503/);
    });

    it('entry 哈希已失效（404）→ 强制刷新指针、按新哈希再取一次', async () => {
        const routes: Routes = { ...h1Routes('eold0000'), ...currentRoutes };
        delete routes[`${BASE}/h1/entry/${ID}.eold0000.json`];
        const { f, fn } = make(routes);
        // 第一次解析拿到旧哈希；刷新后指针指向新 root，新分片给出新哈希
        let pointerCalls = 0;
        fn.mockImplementation((async (url: string) => {
            const key = url.split('?')[0];
            if (key === `${BASE}/h1/manifest-root.json`) {
                pointerCalls += 1;
                const root = pointerCalls === 1 ? 'r1.json' : 'r2.json';
                return { ok: true, status: 200, json: async () => ({ root }) } as Response;
            }
            const table: Routes = {
                [`${BASE}/h1/roots/r1.json`]: { shardKeyLength: 2, shards: { '9c': 'sold' } },
                [`${BASE}/h1/roots/r2.json`]: { shardKeyLength: 2, shards: { '9c': 'snew' } },
                [`${BASE}/h1/manifest/9c.sold.json`]: { [ID]: 'eold0000' },
                [`${BASE}/h1/manifest/9c.snew.json`]: { [ID]: 'enew0000' },
                [`${BASE}/h1/entry/${ID}.enew0000.json`]: ENTRY,
            };
            if (key in table) return { ok: true, status: 200, json: async () => table[key] } as Response;
            return { ok: false, status: 404, json: async () => ({}) } as Response;
        }) as never);
        const r = await f.getItem(ID);
        expect(r).toEqual({ entry: ENTRY, source: 'h1', version: 'h1:r2.json' });
        expect(pointerCalls).toBe(2);
    });

    it('不可变对象进程内缓存：同分片第二条只多取 entry', async () => {
        const ID2 = 'd59f2abcde9c';
        const routes = {
            ...h1Routes(),
            [`${BASE}/h1/manifest/9c.s9c00000.json`]: { [ID]: 'e1111111', [ID2]: 'e2222222' },
            [`${BASE}/h1/entry/${ID2}.e2222222.json`]: { id: ID2, type: 'work', title: '另一條' },
        };
        const { f, calls } = make(routes);
        await f.getItem(ID);
        const before = calls.length;
        expect((await f.getItem(ID2))?.entry.title).toBe('另一條');
        expect(calls.slice(before).map((u) => u.split('?')[0])).toEqual([`${BASE}/h1/entry/${ID2}.e2222222.json`]);
    });

    it('指针缓存 60 秒，过期后重取', async () => {
        let t = 1_000_000;
        const { f, calls } = make({ ...h1Routes(), ...currentRoutes }, () => t);
        await f.getItem(ID);
        t += 30_000;
        await f.getItem(ID);
        expect(calls.filter((u) => u.includes('manifest-root.json'))).toHaveLength(1);
        t += 31_000;
        await f.getItem(ID);
        expect(calls.filter((u) => u.includes('manifest-root.json'))).toHaveLength(2);
    });

    it('失败的请求不留在缓存里，下次重试', async () => {
        const routes: Routes = { ...h1Routes(), ...currentRoutes, [`${BASE}/h1/roots/r1.json`]: 'THROW' };
        const { f, fn } = make(routes);
        expect((await f.getItem(ID))?.source).toBe('current');
        routes[`${BASE}/h1/roots/r1.json`] = { shardKeyLength: 2, shards: { '9c': 's9c00000' } };
        fn.mockImplementation(mockFetch(routes).fn as never);
        expect((await f.getItem(ID))?.source).toBe('h1');
    });
});

describe("createItemFetcher.getItem(id, { prefer: 'current' })（overview#322 B1）", () => {
    it('先走 current/：latest.json → current/entry，2 跳，不碰 h1', async () => {
        const { f, calls } = make({ ...h1Routes(), ...currentRoutes });
        const r = await f.getItem(ID, { prefer: 'current' });
        expect(r).toEqual({ entry: { ...ENTRY, title: '史記（current）' }, source: 'current', version: 'current:abc123' });
        expect(calls.map((u) => u.split('?')[0])).toEqual([`${BASE}/latest.json`, `${BASE}/current/entry/${ID}.json`]);
    });

    it('current/ 确定没有 → 再问 h1；h1 有就用 h1', async () => {
        const { f } = make({ ...h1Routes(), [`${BASE}/latest.json`]: { commitId: 'abc123' } });
        expect(await f.getItem(ID, { prefer: 'current' })).toEqual({ entry: ENTRY, source: 'h1', version: 'h1:r1.json' });
    });

    it('current/ 与 h1 都没有 → null；h1 查不了也按没有算', async () => {
        expect(await make({ [`${BASE}/latest.json`]: { commitId: 'abc123' } }).f.getItem(ID, { prefer: 'current' })).toBeNull();
        const down = make({ [`${BASE}/latest.json`]: { commitId: 'abc123' }, [`${BASE}/h1/manifest-root.json`]: 'THROW' });
        expect(await down.f.getItem(ID, { prefer: 'current' })).toBeNull();
    });

    it('current/ 网络错 → 回到 h1 优先的取法', async () => {
        const { f } = make({ ...h1Routes(), [`${BASE}/latest.json`]: { commitId: 'abc123' }, [`${BASE}/current/entry/${ID}.json`]: 'THROW' });
        expect(await f.getItem(ID, { prefer: 'current' })).toEqual({ entry: ENTRY, source: 'h1', version: 'h1:r1.json' });
    });

    it('两边都出网络错 → 抛错（临时故障不当成 404）', async () => {
        const { f } = make({ [`${BASE}/latest.json`]: 'THROW', [`${BASE}/h1/manifest-root.json`]: 'THROW' });
        await expect(f.getItem(ID, { prefer: 'current' })).rejects.toThrow();
    });

    it('非法 id 直接返回 null，一次请求都不发', async () => {
        const { f, calls } = make({ ...currentRoutes });
        expect(await f.getItem('bad..id', { prefer: 'current' })).toBeNull();
        expect(calls).toEqual([]);
    });
});

describe('网络错与 5xx 原地重试一次（overview#322：冷渲染时的临时故障不让整页 500）', () => {
    /** 第 n 次请求某个 URL 时的行为：'THROW' | 状态码 | 数据 */
    function flaky(plan: Record<string, unknown[]>) {
        const seen: Record<string, number> = {};
        const calls: string[] = [];
        const fn = jest.fn(async (url: string) => {
            calls.push(url);
            const key = url.split('?')[0];
            const steps = plan[key];
            if (!steps) return { ok: false, status: 404, json: async () => ({}) } as Response;
            const v = steps[Math.min(seen[key] = (seen[key] ?? -1) + 1, steps.length - 1)];
            if (v === 'THROW') throw new TypeError('fetch failed');
            if (typeof v === 'number') return { ok: v < 400, status: v, json: async () => ({}) } as Response;
            return { ok: true, status: 200, json: async () => v } as Response;
        });
        return { fn, calls };
    }

    it('网络错一次 → 重试后拿到，不回退、不抛错', async () => {
        const { fn, calls } = flaky({ [`${BASE}/latest.json`]: ['THROW', { commitId: 'abc123' }], [`${BASE}/current/entry/${ID}.json`]: [ENTRY] });
        const f = createItemFetcher({ base: BASE, fetch: fn as never, retryDelayMs: 0 });
        expect(await f.getItem(ID, { prefer: 'current' })).toMatchObject({ source: 'current' });
        expect(calls.map((u) => u.split('?')[0])).toEqual([`${BASE}/latest.json`, `${BASE}/latest.json`, `${BASE}/current/entry/${ID}.json`]);
    });

    it('5xx 一次 → 重试后拿到；连续失败只重试 retries 次就抛', async () => {
        const ok = flaky({ [`${BASE}/latest.json`]: [{ commitId: 'c' }], [`${BASE}/current/items/x/manifest.json`]: [502, { versions: [] }] });
        const f = createItemFetcher({ base: BASE, fetch: ok.fn as never, retryDelayMs: 0 });
        expect(await f.getCurrentJson('items/x/manifest.json')).toEqual({ versions: [] });

        const bad = flaky({ [`${BASE}/latest.json`]: [{ commitId: 'c' }], [`${BASE}/current/items/x/manifest.json`]: [503] });
        const g = createItemFetcher({ base: BASE, fetch: bad.fn as never, retryDelayMs: 0, retries: 2 });
        await expect(g.getCurrentJson('items/x/manifest.json')).rejects.toThrow('HTTP 503');
        expect(bad.calls.filter((u) => u.includes('manifest.json'))).toHaveLength(3);
    });

    it('404 不重试（确定没有）；retries: 0（中间件）不重试', async () => {
        const nf = flaky({ [`${BASE}/latest.json`]: [{ commitId: 'c' }] });
        const f = createItemFetcher({ base: BASE, fetch: nf.fn as never, retryDelayMs: 0 });
        expect(await f.getCurrentJson('items/x/manifest.json')).toBeNull();
        expect(nf.calls.filter((u) => u.includes('manifest.json'))).toHaveLength(1);

        const once = flaky({ [`${BASE}/latest.json`]: ['THROW', { commitId: 'c' }] });
        const g = createItemFetcher({ base: BASE, fetch: once.fn as never, retryDelayMs: 0, retries: 0 });
        await expect(g.getCurrentJson('items/x/manifest.json')).rejects.toThrow('fetch failed');
        expect(once.calls).toHaveLength(1);
    });

    it('正文（getCurrentText）同样重试', async () => {
        const fn = jest.fn()
            .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ commitId: 'c' }) } as Response)
            .mockRejectedValueOnce(new TypeError('fetch failed'))
            .mockResolvedValueOnce({ ok: true, status: 200, text: async () => '正文' } as Response);
        const f = createItemFetcher({ base: BASE, fetch: fn as never, retryDelayMs: 0 });
        expect(await f.getCurrentText('items/x/default/001.txt')).toBe('正文');
        expect(fn).toHaveBeenCalledTimes(3);
    });
});

describe('createItemFetcher 的 forceCache 选项', () => {
    it('默认带 cache: force-cache（页面保持 ISR）', async () => {
        const { f, fn } = make({ ...h1Routes(), ...currentRoutes });
        await f.getItem(ID);
        expect(fn).toHaveBeenCalled();
        for (const [, init] of fn.mock.calls as unknown as [string, RequestInit][]) {
            expect(init.cache).toBe('force-cache');
        }
    });

    it('forceCache: false 时 init 里没有 cache（中间件／边缘运行时）', async () => {
        const { fn } = mockFetch({ ...h1Routes(), ...currentRoutes });
        const f = createItemFetcher({ base: BASE, fetch: fn as never, now: () => 1_000_000, forceCache: false });
        expect(await f.getItem(ID)).toMatchObject({ source: 'h1' });
        expect(fn).toHaveBeenCalled();
        for (const [, init] of fn.mock.calls as unknown as [string, RequestInit][]) {
            expect(init).not.toHaveProperty('cache');
            expect(init.signal).toBeDefined();
        }
    });
});

describe('createItemFetcher.resolvePromotion（PH）', () => {
    const DRAFT = '11pcgxhot4bnk';   // 分片键 'nk'
    const PROD = '96kzii6z28';
    function promoRoutes(extra: Routes = {}): Routes {
        return {
            [`${BASE}/h1/manifest-root.json`]: { version: 2, root: 'r1.json' },
            [`${BASE}/h1/roots/r1.json`]: { shardKeyLength: 2, shards: {}, promotionShards: { nk: 'pnk00000' } },
            [`${BASE}/h1/promotions/nk.pnk00000.json`]: { [DRAFT]: PROD, '22pcgxhot4bnk': '22pcgxhot4bnk' },
            ...extra,
        };
    }

    it('命中：指针 → root.promotionShards → 分片，返回正式 id', async () => {
        const { f, calls } = make(promoRoutes());
        expect(await f.resolvePromotion(DRAFT)).toEqual({ status: 'promoted', to: PROD });
        expect(calls.map((u) => u.split('?')[0])).toEqual([
            `${BASE}/h1/manifest-root.json`,
            `${BASE}/h1/roots/r1.json`,
            `${BASE}/h1/promotions/nk.pnk00000.json`,
        ]);
    });

    it('分片里没有这个 id → absent', async () => {
        const { f } = make(promoRoutes());
        expect(await f.resolvePromotion('33pcgxhot4bnk')).toEqual({ status: 'absent' });
    });

    it('root 里没有这个后缀的分片 → absent，不再多发请求', async () => {
        const { f, calls } = make(promoRoutes());
        expect(await f.resolvePromotion('11pcgxhot4zz')).toEqual({ status: 'absent' });
        expect(calls).toHaveLength(2);
    });

    it('空对照表（promotionShards 为 {}）→ absent', async () => {
        const { f } = make(promoRoutes({ [`${BASE}/h1/roots/r1.json`]: { shardKeyLength: 2, shards: {}, promotionShards: {} } }));
        expect(await f.resolvePromotion(DRAFT)).toEqual({ status: 'absent' });
    });

    it('指向自己的记录不算升格 → absent', async () => {
        const { f } = make(promoRoutes());
        expect(await f.resolvePromotion('22pcgxhot4bnk')).toEqual({ status: 'absent' });
    });

    it('旧 root（没有 promotionShards 字段）→ unknown', async () => {
        const { f } = make(h1Routes());
        expect(await f.resolvePromotion(DRAFT)).toEqual({ status: 'unknown' });
    });

    it('旧格式指针（无 root 字段）→ unknown', async () => {
        const { f } = make({ [`${BASE}/h1/manifest-root.json`]: { version: 1 } });
        expect(await f.resolvePromotion(DRAFT)).toEqual({ status: 'unknown' });
    });

    it('分片网络错 / 5xx → unknown（不当成「没升格」）', async () => {
        const a = make(promoRoutes({ [`${BASE}/h1/promotions/nk.pnk00000.json`]: 'THROW' }));
        expect(await a.f.resolvePromotion(DRAFT)).toEqual({ status: 'unknown' });
        const b = make(promoRoutes({ [`${BASE}/h1/promotions/nk.pnk00000.json`]: 503 }));
        expect(await b.f.resolvePromotion(DRAFT)).toEqual({ status: 'unknown' });
    });

    it('非法 id → absent，一次请求都不发', async () => {
        const { f, calls } = make(promoRoutes());
        expect(await f.resolvePromotion('../etc')).toEqual({ status: 'absent' });
        expect(calls).toHaveLength(0);
    });

    it('与 getItem 共用指针与 root 缓存：先取条目再查升格，只多取一片对照表', async () => {
        const routes = { ...h1Routes(), ...promoRoutes({
            [`${BASE}/h1/roots/r1.json`]: { shardKeyLength: 2, shards: { '9c': 's9c00000' }, promotionShards: { nk: 'pnk00000' } },
        }) };
        const { f, calls } = make(routes);
        await f.getItem(ID);
        const before = calls.length;
        expect(await f.resolvePromotion(DRAFT)).toEqual({ status: 'promoted', to: PROD });
        expect(calls.slice(before).map((u) => u.split('?')[0])).toEqual([`${BASE}/h1/promotions/nk.pnk00000.json`]);
    });
});

describe('summarizeItem', () => {
    it('作品：作者一行、卷数、简介（description 为 {text}）', () => {
        const s = summarizeItem({
            ...ENTRY,
            authors: [{ name: '司馬遷', role: '撰', dynasty: '西漢' }, { name: '裴駰', role: '集解', dynasty: '南朝宋' }],
            description: { text: '今存。' },
            juan_count: { number: 130 },
        }, ID);
        expect(s).toMatchObject({ title: '史記', authorLine: '（西漢）司馬遷撰、（南朝宋）裴駰集解', measure: '130卷', description: '今存。' });
    });

    it('measure_info 优先于 juan_count；description 可为字符串', () => {
        const s = summarizeItem({ id: 'x', type: 'work', title: 't', measure_info: '一百三十篇', juan_count: 130, description: ' 簡介 ' }, 'x');
        expect(s.measure).toBe('一百三十篇');
        expect(s.description).toBe('簡介');
    });

    it('人物用 primary_name；版本带 edition；缺字段不报错', () => {
        expect(summarizeItem({ id: 'p', type: 'entity', primary_name: '黃謨' }, 'p').title).toBe('黃謨');
        expect(summarizeItem({ id: 'b', type: 'book', title: '九經字樣', edition: '薈要本' }, 'b').edition).toBe('薈要本');
        expect(summarizeItem({ authors: [null, { role: '撰' }], juan_count: { number: 0 } } as never, 'q')).toMatchObject({
            title: 'q', authorLine: '', measure: '', description: '',
        });
    });
});

describe('超时信号（FX1c）', () => {
    it('运行时没有 AbortSignal.timeout 时退回 AbortController，照样带 signal', async () => {
        const orig = AbortSignal.timeout;
        // @ts-expect-error 模拟不支持的运行时
        delete AbortSignal.timeout;
        try {
            const { fn } = mockFetch(h1Routes());
            const f = createItemFetcher({ base: BASE, fetch: fn as never, timeoutMs: 50 });
            expect((await f.getItem(ID))?.entry.title).toBe('史記');
            const init = (fn.mock.calls[0] as unknown[])[1] as RequestInit;
            expect(init.signal).toBeInstanceOf(AbortSignal);
        } finally {
            AbortSignal.timeout = orig;
        }
    });

    describe('兜底分支的定时器（没有 AbortSignal.timeout 时）', () => {
        let orig: typeof AbortSignal.timeout;
        beforeEach(() => {
            orig = AbortSignal.timeout;
            // @ts-expect-error 模拟不支持的运行时
            delete AbortSignal.timeout;
            jest.useFakeTimers();
        });
        afterEach(() => {
            jest.useRealTimers();
            AbortSignal.timeout = orig;
        });

        it('取数成功与失败后都清掉定时器，不留挂起的计时器', async () => {
            const { fn } = mockFetch(h1Routes());
            const f = createItemFetcher({ base: BASE, fetch: fn as never, timeoutMs: 3_000 });
            expect((await f.getItem(ID))?.entry.title).toBe('史記');
            expect(jest.getTimerCount()).toBe(0);

            const bad = mockFetch({ [`${BASE}/h1/manifest-root.json`]: 'THROW', [`${BASE}/latest.json`]: 503 });
            const g = createItemFetcher({ base: BASE, fetch: bad.fn as never, timeoutMs: 3_000, retries: 0 });
            await expect(g.getItem(ID)).rejects.toThrow('HTTP 503');
            expect(jest.getTimerCount()).toBe(0);
        });

        it('超时时以 DOMException TimeoutError 中止，与原生 AbortSignal.timeout 一致', async () => {
            let seen: AbortSignal | undefined;
            const hang = jest.fn((_url: string, init?: RequestInit) => new Promise<Response>((_res, rej) => {
                seen = init?.signal ?? undefined;
                seen?.addEventListener('abort', () => rej(seen?.reason));
            }));
            const f = createItemFetcher({ base: BASE, fetch: hang as never, timeoutMs: 3_000 });
            // 先挂断言再推进时间：h1 超时回退 current/，current/ 也超时 → 抛出超时错误
            const done = expect(f.getItem(ID)).rejects.toMatchObject({ name: 'TimeoutError' });
            await jest.advanceTimersByTimeAsync(3_000);
            await jest.advanceTimersByTimeAsync(3_000);
            await done;
            expect(seen?.reason).toBeInstanceOf(DOMException);
            expect(jest.getTimerCount()).toBe(0);
        });
    });
});

describe('getCurrentText（WEB2：阅读页首卷正文）', () => {
    function textFetch(routes: Record<string, string | number>) {
        const calls: string[] = [];
        const fn = jest.fn(async (url: string) => {
            calls.push(url);
            const key = url.split('?')[0];
            if (key === `${BASE}/latest.json`) return { ok: true, status: 200, json: async () => ({ commitId: 'c1', cacheKey: 'k1' }) } as Response;
            const v = routes[key];
            if (v === undefined) return { ok: false, status: 404, text: async () => '' } as Response;
            if (typeof v === 'number') return { ok: v < 400, status: v, text: async () => '' } as Response;
            return { ok: true, status: 200, text: async () => v } as Response;
        });
        return { fn, calls };
    }

    it('带版本键取 current/ 下的文本；没有返回 null；超过上限返回 null', async () => {
        const { fn, calls } = textFetch({ [`${BASE}/current/items/x/full_text/001.txt`]: '正文' });
        const f = createItemFetcher({ base: BASE, fetch: fn });
        await expect(f.getCurrentText('items/x/full_text/001.txt')).resolves.toBe('正文');
        expect(calls).toContain(`${BASE}/current/items/x/full_text/001.txt?v=k1`);
        await expect(f.getCurrentText('items/x/full_text/002.txt')).resolves.toBeNull();
        await expect(f.getCurrentText('items/x/full_text/001.txt', 1)).resolves.toBeNull();
    });

    it('5xx 抛错，不当成没有', async () => {
        const { fn } = textFetch({ [`${BASE}/current/a.txt`]: 502 });
        const f = createItemFetcher({ base: BASE, fetch: fn });
        await expect(f.getCurrentText('a.txt')).rejects.toThrow('HTTP 502');
    });
});
