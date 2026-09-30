/**
 * @jest-environment node
 *
 * 反馈公开列表的缓存与超时（overview#304）：
 *   命中／过期先给旧的／读不到回 503 而不是 500／管理读不缓存／写入后清缓存／并发合并。
 */

const g = globalThis as unknown as Record<string, unknown>;

const store = new Map<string, string>();
const stats = { list: 0, get: 0 };
let hang = false;
let fail = false;
const kv = {
    async get(k: string) {
        stats.get += 1;
        if (hang) return new Promise(() => {});
        if (fail) throw new Error('kv boom');
        const v = store.get(k);
        return v ? JSON.parse(v) : null;
    },
    async put(k: string, v: string) {
        store.set(k, v);
    },
    async list(opts: { prefix?: string; limit?: number; cursor?: string }) {
        stats.list += 1;
        if (hang) return new Promise(() => {});
        if (fail) throw new Error('kv boom');
        const all = [...store.keys()].filter((k) => k.startsWith(opts.prefix || '')).sort();
        return { keys: all.map((key) => ({ key })), complete: true, cursor: '' };
    },
};

function seedOne(n: number) {
    const id = `fb_${1_700_000_000_000 + n * 1000}_x${n}`;
    store.set(id, JSON.stringify({
        id, type: 'bug', content: `#${n}`, pageUrl: '', resourceId: '',
        createdAt: new Date(1_700_000_000_000 + n * 1000).toISOString(), status: 'pending', reply: '',
    }));
}
const ctx = (qs = '', headers: Record<string, string> = {}) => ({
    request: new Request(`https://x/api/feedback?${qs}`, { headers }),
    env: { FEEDBACK_KV: kv, FEEDBACK_ADMIN_TOKEN: 'adm' },
    waitUntil: (p: Promise<unknown>) => { pending.push(p); },
});
let pending: Promise<unknown>[] = [];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mod: any;
beforeAll(async () => {
    mod = await import('../../../../edge-functions/api/feedback.js');
});
beforeEach(() => {
    store.clear();
    stats.list = 0; stats.get = 0; hang = false; fail = false; pending = [];
    delete g.__kygFeedbackListCache;
    jest.useRealTimers();
});
afterEach(() => jest.useRealTimers());

const body = async (r: Response) => JSON.parse(await r.text());

describe('公开列表缓存', () => {
    it('第二次读命中缓存，不再碰 KV', async () => {
        seedOne(1);
        const r1 = await mod.onRequestGet(ctx());
        expect(r1.headers.get('X-Feedback-Cache')).toBe('MISS');
        const listed = stats.list;
        const r2 = await mod.onRequestGet(ctx());
        expect(r2.headers.get('X-Feedback-Cache')).toBe('HIT');
        expect(stats.list).toBe(listed);
        expect((await body(r2)).items ?? (await body(r1)).items).toBeDefined();
    });

    it('fresh=1 绕过缓存', async () => {
        seedOne(1);
        await mod.onRequestGet(ctx());
        const r = await mod.onRequestGet(ctx('fresh=1'));
        expect(r.headers.get('X-Feedback-Cache')).toBe('BYPASS');
    });

    it('提交后清缓存：马上能读到新条目', async () => {
        seedOne(1);
        const before = await body(await mod.onRequestGet(ctx()));
        const post = await mod.onRequestPost({
            request: new Request('https://x/api/feedback', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ type: 'bug', content: '新的一条反馈内容', pageUrl: '' }),
            }),
            env: { FEEDBACK_KV: kv },
            waitUntil: () => {},
        });
        expect(post.status).toBe(200);
        const after = await mod.onRequestGet(ctx());
        expect(after.headers.get('X-Feedback-Cache')).toBe('MISS');
        const a = await body(after);
        const list = (k: Record<string, unknown>) => (k.items ?? k.feedbacks ?? k.data) as unknown[];
        expect(list(a).length).toBe(list(before).length + 1);
    });

    it('并发的读合并成一次 KV 读取', async () => {
        seedOne(1);
        await Promise.all([mod.onRequestGet(ctx()), mod.onRequestGet(ctx()), mod.onRequestGet(ctx())]);
        expect(stats.list).toBe(1);
    });

    it('管理读不进缓存也不读缓存', async () => {
        seedOne(1);
        await mod.onRequestGet(ctx());
        const r = await mod.onRequestGet(ctx('', { Authorization: 'Bearer adm' }));
        expect(r.headers.get('X-Feedback-Cache')).toBeNull();
        expect(stats.list).toBe(2);
    });
});

describe('超时与失败', () => {
    it('读不到且无旧缓存：503 + code，不是 500', async () => {
        fail = true;
        const r = await mod.onRequestGet(ctx());
        expect(r.status).toBe(503);
        expect(r.headers.get('Retry-After')).toBe('10');
        expect(r.headers.get('Cache-Control')).toBe('no-store');
        const b = await body(r);
        expect(b.success).toBe(false);
        expect(b.code).toBe('upstream_error');
    });

    it('KV 卡住超过预算：503 upstream_timeout', async () => {
        jest.useFakeTimers();
        hang = true;
        const p = mod.onRequestGet(ctx());
        await jest.advanceTimersByTimeAsync(8100);
        const r = await p;
        expect(r.status).toBe(503);
        expect((await body(r)).code).toBe('upstream_timeout');
    });

    it('缓存过期后刷新失败：给旧的（STALE），不报错', async () => {
        jest.useFakeTimers();
        seedOne(1);
        const r1 = await mod.onRequestGet(ctx());
        const first = await body(r1);
        await jest.advanceTimersByTimeAsync(60_000);
        fail = true;
        const r2 = await mod.onRequestGet(ctx());
        expect(r2.status).toBe(200);
        expect(r2.headers.get('X-Feedback-Cache')).toBe('STALE');
        expect(await body(r2)).toEqual(first);
        await Promise.all(pending);
    });

    it('超过 10 分钟的旧缓存不再使用', async () => {
        jest.useFakeTimers();
        seedOne(1);
        await mod.onRequestGet(ctx());
        await jest.advanceTimersByTimeAsync(11 * 60_000);
        fail = true;
        const r = await mod.onRequestGet(ctx());
        expect(r.status).toBe(503);
    });

    it('管理读超时同样回 503', async () => {
        jest.useFakeTimers();
        hang = true;
        const p = mod.onRequestGet(ctx('', { Authorization: 'Bearer adm' }));
        await jest.advanceTimersByTimeAsync(8100);
        expect((await p).status).toBe(503);
    });
});
