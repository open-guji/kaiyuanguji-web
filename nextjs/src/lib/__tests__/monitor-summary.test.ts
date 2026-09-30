/**
 * @jest-environment node
 *
 * MON：track-error／feedback 的监控汇总读接口（?summary=1）。
 *
 * 盯三件：
 *   1. 与原读接口同样 fail-closed——没配 token 回 503、token 不对回 401；
 *   2. 计数按 key 名里的毫秒时间落窗口，对得上；
 *   3. 返回体里**不许**出现 IP、stack、UA、pageUrl、反馈正文——监控只要数，不要人。
 */

const g = globalThis as unknown as Record<string, unknown>;

function makeKv() {
    return {
        store: new Map<string, string>(),
        async get(k: string) {
            const v = this.store.get(k);
            return v ? JSON.parse(v) : null;
        },
        async put(k: string, v: string) {
            this.store.set(k, v);
        },
        async list(opts: { prefix?: string } = {}) {
            const keys = [...this.store.keys()].filter((k) => !opts.prefix || k.startsWith(opts.prefix)).sort();
            return { keys: keys.map((key) => ({ key })), complete: true, cursor: '' };
        },
    };
}

const errKv = makeKv();
const fbKv = makeKv();
const NOW = Date.now();
const MIN = 60_000;

function get(url: string, token?: string) {
    return { request: new Request(url, token ? { headers: { authorization: `Bearer ${token}` } } : undefined) };
}
async function json(res: Response) {
    return JSON.parse(await res.text());
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let te: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let fb: any;

beforeAll(async () => {
    g.ERROR_KV = errKv;
    g.FEEDBACK_KV = fbKv;
    te = await import('../../../../edge-functions/api/track-error.js');
    fb = await import('../../../../edge-functions/api/feedback.js');
});

beforeEach(() => {
    delete (globalThis as Record<string, unknown>).__kygFeedbackListCache;
    errKv.store.clear();
    fbKv.store.clear();
    const rec = (ts: number, i: number, message: string) => {
        const id = `err_${ts}_${String(i).padStart(6, 'a')}`;
        errKv.store.set(id, JSON.stringify({
            id, kind: 'fetch', message, stack: 'at secret.js:1:1', clientIp: '9.8.7.6',
            ua: 'Mozilla', pageUrl: 'https://www.kaiyuanguji.com/private', createdAt: new Date(ts).toISOString(),
        }));
    };
    // 最近 1 小时 5 条（3 条同一消息），1～24 小时 7 条，更早 2 条
    for (let i = 0; i < 3; i += 1) rec(NOW - (10 + i) * MIN, i, 'load failed 1.2.3.4 user@example.com');
    for (let i = 3; i < 5; i += 1) rec(NOW - (20 + i) * MIN, i, 'chunk error');
    for (let i = 5; i < 12; i += 1) rec(NOW - (2 + i) * 60 * MIN, i, 'old');
    for (let i = 12; i < 14; i += 1) rec(NOW - 30 * 60 * MIN - i, i, 'older');

    const fbRec = (ts: number, i: number) => {
        const id = `fb_${ts}_${String(i).padStart(4, 'x')}`;
        fbKv.store.set(id, JSON.stringify({ id, content: '我的电话 13912345678', contact: 'a@b.com', createdAt: new Date(ts).toISOString() }));
    };
    fbRec(NOW - 5 * MIN, 1);
    fbRec(NOW - 50 * MIN, 2);
    fbRec(NOW - 5 * 60 * MIN, 3);
    fbRec(NOW - 48 * 60 * MIN, 4);
});

afterEach(() => {
    delete g.ERROR_VIEW_TOKEN;
    delete g.FEEDBACK_ADMIN_TOKEN;
});

describe('GET /api/track-error?summary=1', () => {
    it('没配 ERROR_VIEW_TOKEN 时 503，不放行', async () => {
        const res = await te.onRequestGet(get('https://x/api/track-error?summary=1', 'anything'));
        expect(res.status).toBe(503);
    });

    it('token 不对 401', async () => {
        g.ERROR_VIEW_TOKEN = 'right';
        const res = await te.onRequestGet(get('https://x/api/track-error?summary=1', 'wrong'));
        expect(res.status).toBe(401);
    });

    it('计数按窗口落对，前 5 种按次数排序', async () => {
        g.ERROR_VIEW_TOKEN = 'right';
        const res = await te.onRequestGet(get('https://x/api/track-error?summary=1&window=1h', 'right'));
        expect(res.status).toBe(200);
        const b = await json(res);
        expect(b.count).toBe(5);
        expect(b.count24h).toBe(12);
        expect(b.avgPerHour24h).toBe(0.5);
        expect(b.top[0]).toEqual({ kind: 'fetch', message: expect.any(String), count: 3 });
        expect(b.top[1].count).toBe(2);
    });

    it('不再认 ?token=（M1：查询串会进访问日志），只认 Authorization: Bearer', async () => {
        g.ERROR_VIEW_TOKEN = 'right';
        const res = await te.onRequestGet({ request: new Request('https://x/api/track-error?summary=1&token=right') });
        expect(res.status).toBe(401);
    });

    it('返回体不含 IP／stack／UA／pageUrl，消息里的邮箱与 IP 打码', async () => {
        g.ERROR_VIEW_TOKEN = 'right';
        const text = await (await te.onRequestGet(get('https://x/api/track-error?summary=1', 'right'))).text();
        for (const leak of ['9.8.7.6', 'secret.js', 'Mozilla', '/private', 'user@example.com', '1.2.3.4', 'clientIp', 'stack']) {
            expect(text).not.toContain(leak);
        }
    });
});

describe('GET /api/feedback?summary=1', () => {
    it('没配 FEEDBACK_ADMIN_TOKEN 时 503', async () => {
        const res = await fb.onRequestGet(get('https://x/api/feedback?summary=1', 'x'));
        expect(res.status).toBe(503);
    });

    it('token 不对 401', async () => {
        g.FEEDBACK_ADMIN_TOKEN = 'adm';
        const res = await fb.onRequestGet(get('https://x/api/feedback?summary=1', 'no'));
        expect(res.status).toBe(401);
    });

    it('只回条数，不回任何反馈内容', async () => {
        g.FEEDBACK_ADMIN_TOKEN = 'adm';
        const res = await fb.onRequestGet(get('https://x/api/feedback?summary=1&window=1h', 'adm'));
        expect(res.status).toBe(200);
        const text = await res.text();
        const b = JSON.parse(text);
        expect(b.count).toBe(2);
        expect(b.count24h).toBe(3);
        expect(b.total).toBe(4);
        expect(text).not.toContain('13912345678');
        expect(text).not.toContain('a@b.com');
        expect(b.items).toBeUndefined();
    });

    it('不带 summary 的公开读不受影响', async () => {
        const res = await fb.onRequestGet(get('https://x/api/feedback'));
        expect(res.status).toBe(200);
        expect((await json(res)).items).toBeDefined();
    });
});
