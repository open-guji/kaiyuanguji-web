/**
 * @jest-environment node
 *
 * M3（SEC overview#134）：公开 POST /api/feedback 的防刷。
 *  1) pageUrl／resourceId 必须是字符串，超过 500 字截断
 *  2) 同一 IP 每 10 分钟最多 10 条，第 11 条 429（带 Retry-After）；换 IP、过了窗口照常；
 *     管理侧 action:'update' 不计入；KV 里不存明文 IP
 *  3) 新反馈推送每 5 分钟最多 1 条，窗口内的并进下一条（「另有 N 条」）
 */

export {};

function makeKv() {
    const store = new Map<string, string>();
    return {
        store,
        async get(k: string, t?: string) {
            const v = store.get(k);
            if (v === undefined) return null;
            return t === 'json' ? JSON.parse(v) : v;
        },
        async put(k: string, v: string) { store.set(k, v); },
        async list(opts: { prefix?: string } = {}) {
            const keys = [...store.keys()].filter((k) => k.startsWith(opts.prefix || '')).sort().map((key) => ({ key }));
            return { keys, complete: true, cursor: '' };
        },
    };
}

/* eslint-disable @typescript-eslint/no-explicit-any */
let fn: any;
let kv: ReturnType<typeof makeKv>;
let pending: Promise<unknown>[];
let env: Record<string, unknown>;

beforeAll(async () => {
    fn = await import('../../../../edge-functions/api/feedback.js');
});
beforeEach(() => {
    kv = makeKv();
    pending = [];
    env = { FEEDBACK_KV: kv, FEEDBACK_ADMIN_TOKEN: 'right' };
});
afterEach(() => {
    jest.restoreAllMocks();
    delete (global as any).fetch;
});

function post(body: unknown, ip = '1.2.3.4', headers: Record<string, string> = {}) {
    return {
        env,
        request: new Request('https://x/api/feedback', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'eo-client-ip': ip, ...headers },
            body: JSON.stringify(body),
        }),
        waitUntil: (p: Promise<unknown>) => { pending.push(p); },
    };
}
const fbRecords = () => [...kv.store.entries()].filter(([k]) => k.startsWith('fb_')).map(([, v]) => JSON.parse(v));
const flush = async () => { await Promise.all(pending); pending = []; };

describe('pageUrl／resourceId 类型与长度', () => {
    it.each([
        ['pageUrl 是对象', { pageUrl: { a: 1 } }],
        ['pageUrl 是数字', { pageUrl: 123 }],
        ['resourceId 是数组', { resourceId: ['x'] }],
        ['resourceId 是布尔', { resourceId: true }],
    ])('%s → 400，不落库', async (_l, extra) => {
        const res = await fn.onRequestPost(post({ type: 'bug', content: 'x', ...extra }));
        expect(res.status).toBe(400);
        expect(fbRecords()).toHaveLength(0);
    });

    it('超过 500 字截到 500；缺省或 null 记为空串', async () => {
        const long = 'https://www.kaiyuanguji.com/' + 'a'.repeat(2000);
        expect((await fn.onRequestPost(post({ type: 'bug', content: 'x', pageUrl: long, resourceId: 'r'.repeat(900) }))).status).toBe(200);
        expect((await fn.onRequestPost(post({ type: 'bug', content: 'y', pageUrl: null }))).status).toBe(200);
        const recs = fbRecords().sort((a, b) => a.content.localeCompare(b.content));
        expect(recs[0].pageUrl).toHaveLength(500);
        expect(recs[0].resourceId).toHaveLength(500);
        expect(recs[1].pageUrl).toBe('');
        expect(recs[1].resourceId).toBe('');
    });
});

describe('按 IP 限速：10 分钟 10 条', () => {
    it('同一 IP 第 11 条 429 带 Retry-After，且不落库；别的 IP 不受影响', async () => {
        for (let i = 0; i < 10; i += 1) {
            expect((await fn.onRequestPost(post({ type: 'bug', content: `第 ${i} 条` }))).status).toBe(200);
        }
        const res = await fn.onRequestPost(post({ type: 'bug', content: '第 11 条' }));
        expect(res.status).toBe(429);
        expect(Number(res.headers.get('Retry-After'))).toBeGreaterThan(0);
        expect(Number(res.headers.get('Retry-After'))).toBeLessThanOrEqual(600);
        expect(fbRecords()).toHaveLength(10);
        expect((await fn.onRequestPost(post({ type: 'bug', content: '别的 IP' }, '5.6.7.8'))).status).toBe(200);
    });

    it('过了 10 分钟窗口重新计数', async () => {
        const t0 = Date.now();
        const spy = jest.spyOn(Date, 'now').mockReturnValue(t0);
        for (let i = 0; i < 10; i += 1) await fn.onRequestPost(post({ type: 'bug', content: `c${i}` }));
        expect((await fn.onRequestPost(post({ type: 'bug', content: '超' }))).status).toBe(429);
        spy.mockReturnValue(t0 + 9 * 60 * 1000);
        expect((await fn.onRequestPost(post({ type: 'bug', content: '还在窗口里' }))).status).toBe(429);
        spy.mockReturnValue(t0 + 10 * 60 * 1000 + 1000);
        expect((await fn.onRequestPost(post({ type: 'bug', content: '新窗口' }))).status).toBe(200);
    });

    it('校验不通过的提交不占名额', async () => {
        for (let i = 0; i < 20; i += 1) await fn.onRequestPost(post({ type: 'nope', content: 'x' }));
        expect((await fn.onRequestPost(post({ type: 'bug', content: 'ok' }))).status).toBe(200);
    });

    it('管理侧 action:update 不限速', async () => {
        for (let i = 0; i < 10; i += 1) await fn.onRequestPost(post({ type: 'bug', content: `c${i}` }));
        const id = fbRecords()[0].id;
        for (let i = 0; i < 3; i += 1) {
            const res = await fn.onRequestPost(post({ action: 'update', id, status: 'resolved', token: 'right' }));
            expect(res.status).toBe(200);
        }
    });

    it('计数 key 用 IP 的 sha256，KV 里不出现明文 IP；不以 fb_ 开头、公开读不受影响', async () => {
        await fn.onRequestPost(post({ type: 'bug', content: 'x' }, '203.0.113.9'));
        const keys = [...kv.store.keys()];
        const rl = keys.filter((k) => k.startsWith('ratelimit:feedback:'));
        expect(rl).toHaveLength(1);
        expect(rl[0]).toMatch(/^ratelimit:feedback:[0-9a-f]{64}$/);
        expect([...kv.store.entries()].join('\n')).not.toContain('203.0.113.9');
        const j = JSON.parse(await (await fn.onRequestGet({ env, request: new Request('https://x/api/feedback?limit=20') })).text());
        expect(j.items).toHaveLength(1);
    });
});

describe('推送节流：5 分钟最多 1 条，其余合并', () => {
    it('窗口内只推第一条；窗口过后下一条带上合并条数', async () => {
        env.HEALTH_NOTIFY_WEBHOOK = 'https://hook.example/notify';
        const bodies: string[] = [];
        (global as any).fetch = jest.fn(async (_u: string, init: RequestInit) => { bodies.push(String(init.body)); return new Response('{}'); });
        const t0 = Date.now();
        const spy = jest.spyOn(Date, 'now').mockReturnValue(t0);

        await fn.onRequestPost(post({ type: 'bug', content: '第一条' }, '10.0.0.1')); await flush();
        await fn.onRequestPost(post({ type: 'bug', content: '第二条' }, '10.0.0.2')); await flush();
        spy.mockReturnValue(t0 + 4 * 60 * 1000);
        await fn.onRequestPost(post({ type: 'bug', content: '第三条' }, '10.0.0.3')); await flush();
        expect(bodies).toHaveLength(1);
        expect(bodies[0]).toContain('第一条');
        expect(bodies[0]).not.toContain('另有');

        spy.mockReturnValue(t0 + 5 * 60 * 1000 + 1000);
        await fn.onRequestPost(post({ type: 'suggestion', content: '第四条' }, '10.0.0.4')); await flush();
        expect(bodies).toHaveLength(2);
        expect(bodies[1]).toContain('第四条');
        expect(bodies[1]).toContain('另有 2 条');

        // 合并计数已清零：再过一个窗口推出去的不带「另有」
        spy.mockReturnValue(t0 + 11 * 60 * 1000);
        await fn.onRequestPost(post({ type: 'bug', content: '第五条' }, '10.0.0.5')); await flush();
        expect(bodies).toHaveLength(3);
        expect(bodies[2]).not.toContain('另有');
        // 反馈本身一条不少
        expect(fbRecords()).toHaveLength(5);
    });
});
