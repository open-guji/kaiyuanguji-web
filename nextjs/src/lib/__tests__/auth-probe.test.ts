/**
 * @jest-environment node
 *
 * /api/auth/probe：上线登录方案前验 EdgeOne 运行时能力的一次性端点。
 *
 * 盯四件：
 *  1) 鉴权闸：没配 token 回 503、token 不对回 401（与 track-error / feedback 同形）
 *  2) 探测 key 必须删掉——AUTH_KV 未绑定时它会落进生产 ERROR_KV，TTL 生效与否恰是待验项，不能靠它兜底
 *  3) 删不掉要如实报出来，而不是静默残留
 *  4) Set-Cookie / TTL 过期这两项本端点自证不了，不得算进 allPass
 */

const g = globalThis as unknown as Record<string, unknown>;

type Kv = {
    store: Map<string, string>;
    get(k: string, t?: string): Promise<unknown>;
    put(k: string, v: string, o?: unknown): Promise<void>;
    delete?: (k: string) => Promise<void>;
};

function makeKv(withDelete = true): Kv {
    const kv: Kv = {
        store: new Map<string, string>(),
        async get(k: string) {
            const v = kv.store.get(k);
            return v ? JSON.parse(v) : null;
        },
        async put(k: string, v: string) {
            kv.store.set(k, v);
        },
    };
    if (withDelete) kv.delete = async (k: string) => { kv.store.delete(k); };
    return kv;
}

function get(url = 'https://x/api/auth/probe?token=t0k', env?: Record<string, unknown>) {
    return { request: new Request(url), env };
}
async function json(res: Response) {
    return JSON.parse(await res.text());
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let fn: any;

beforeAll(async () => {
    fn = await import('../../../../edge-functions/api/auth/probe.js');
});

afterEach(() => {
    delete g.AUTH_ADMIN_TOKEN;
    delete g.AUTH_JWT_SECRET;
    delete g.ERROR_KV;
});

describe('GET /api/auth/probe', () => {
    it('没配 AUTH_ADMIN_TOKEN 回 503，token 不对回 401', async () => {
        expect((await fn.onRequestGet(get())).status).toBe(503);
        g.AUTH_ADMIN_TOKEN = 't0k';
        expect((await fn.onRequestGet(get('https://x/api/auth/probe?token=bad'))).status).toBe(401);
        expect((await fn.onRequestGet(get('https://x/api/auth/probe'))).status).toBe(401);
    });

    it('探测 key 落进 ERROR_KV 时必须删干净', async () => {
        g.AUTH_ADMIN_TOKEN = 't0k';
        const kv = makeKv();
        kv.store.set('err_1_a', '{"id":"err_1_a"}');
        g.ERROR_KV = kv;
        const res = await fn.onRequestGet(get());
        expect(res.status).toBe(200);
        const j = await json(res);
        expect(j.probe.kvTtl.pass).toBe(true);
        expect(j.probe.kvTtl.cleanup.deleted).toBe(true);
        expect(j.probe.kvTtl.ttlExpiryVerified).toBe(false);
        // 只剩原有数据，没有 __probe_ 残留
        expect([...kv.store.keys()]).toEqual(['err_1_a']);
    });

    it('KV 没有 delete 方法时如实报残留', async () => {
        g.AUTH_ADMIN_TOKEN = 't0k';
        g.ERROR_KV = makeKv(false);
        const j = await json(await fn.onRequestGet(get()));
        expect(j.probe.kvTtl.cleanup.deleted).toBe(false);
        expect(j.probe.kvTtl.cleanup.detail).toMatch(/__probe_/);
    });

    it('Set-Cookie 不自证、不算进 allPass；其余全绿时 allPass 为真', async () => {
        g.AUTH_ADMIN_TOKEN = 't0k';
        g.AUTH_JWT_SECRET = 's3cret';
        g.ERROR_KV = makeKv();
        const res = await fn.onRequestGet(get());
        const j = await json(res);
        expect(j.probe.setCookie.pass).toBeNull();
        expect(j.allPass).toBe(true);
        expect(j.manualChecks.length).toBeGreaterThanOrEqual(2);
        expect(res.headers.get('set-cookie')).toMatch(/probe=1/);
    });
});
