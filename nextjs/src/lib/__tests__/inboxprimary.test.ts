/**
 * @jest-environment node
 *
 * 票以 D1 为真源（WEB_INBOX_PRIMARY=1）：cellreview 不写 KV、写 D1 失败回 500、管理读走 D1。
 */
const g = globalThis as unknown as Record<string, unknown>;
const realFetch = globalThis.fetch;
const store = new Map<string, string>();
const kv = {
    async get(k: string) { const v = store.get(k); return v ? JSON.parse(v) : null; },
    async put(k: string, v: string) { store.set(k, v); },
    async list() { return { keys: [], complete: true, cursor: '' }; },
};
const calls: Array<{ url: string; init: RequestInit }> = [];
let respond: (url: string, init: RequestInit) => Response = () => new Response('{}', { status: 201 });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let fn: any;

beforeAll(async () => {
    g.FEEDBACK_KV = kv;
    fn = await import('../../../../edge-functions/api/cellreview.js');
});
beforeEach(() => {
    fn.resetMemRateLimit(); store.clear(); calls.length = 0;
    g.FEEDBACK_ADMIN_TOKEN = 'right';
    respond = () => new Response('{}', { status: 201 });
    g.fetch = async (url: string, init: RequestInit) => { calls.push({ url, init }); return respond(url, init); };
});
afterEach(() => { delete g.FEEDBACK_ADMIN_TOKEN; });
afterAll(() => { g.fetch = realFetch; });

const PRIMARY = { WEB_INBOX_PRIMARY: '1', WEB_INBOX_URL: 'https://w.example', WEB_INBOX_TOKEN: 't' };
const base = { book: 'd59f2870u874', vol: 'vol01', a: '12:3:7', rev: 'vol01-r1', aid: 'aid_abcdefgh1234', shown: '於', choice: 'char', char: '于' };
const post = (body: unknown, env: Record<string, string> = PRIMARY) => {
    const request = new Request('https://x/api/cellreview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    (request as unknown as { eo: unknown }).eo = { clientIp: '1.2.3.4' };
    return { request, env };
};
const get = (qs: string, env: Record<string, string> = PRIMARY) => ({ request: new Request(`https://x/api/cellreview?${qs}`, { headers: { Authorization: 'Bearer right' } }), env });

describe('cellreview · D1 为真源', () => {
    it('POST：只写 D1（一次），不写 KV', async () => {
        const res = await fn.onRequestPost(post(base));
        expect(res.status).toBe(200);
        expect(store.size).toBe(0);
        expect(calls).toHaveLength(1);
        expect(calls[0].url).toBe('https://w.example/v1/web/inbox');
        const item = JSON.parse(calls[0].init.body as string).items[0];
        expect(item.kind).toBe('cellreview');
        expect(item.key).toMatch(/^cr:vol01-r1:d59f2870u874:12:3:7:[0-9a-f]{16}$/);
        expect(item.value.char).toBe('于');
    });
    it('POST：Worker 5xx 重试一次，仍失败回 500，且不写 KV', async () => {
        respond = () => new Response('x', { status: 502 });
        const res = await fn.onRequestPost(post(base));
        expect(res.status).toBe(500);
        expect(calls).toHaveLength(2);
        expect(store.size).toBe(0);
    });
    it('POST：第一次抖动、第二次成功 → 200', async () => {
        let n = 0;
        respond = () => (++n === 1 ? new Response('x', { status: 503 }) : new Response('{}', { status: 201 }));
        expect((await fn.onRequestPost(post(base))).status).toBe(200);
        expect(calls).toHaveLength(2);
    });
    it('POST：Worker 4xx（键不合法等）不重试直接 500', async () => {
        respond = () => new Response('x', { status: 400 });
        expect((await fn.onRequestPost(post(base))).status).toBe(500);
        expect(calls).toHaveLength(1);
    });
    it('POST：开关没开仍走 KV（老路径不变）', async () => {
        const res = await fn.onRequestPost(post(base, {}));
        expect(res.status).toBe(200);
        expect([...store.keys()].some((k) => k.startsWith('cr:'))).toBe(true);
    });
    it('GET 管理读：按条目读走 D1 前缀，cursor 即 seq', async () => {
        respond = () => new Response(JSON.stringify({ items: [{ seq: 5, value: { v: 1, a: 'x' } }, { seq: 6, value: { v: 1, a: 'y' } }], next: 6, hasMore: true }), { status: 200 });
        const res = await fn.onRequestGet(get('items=1&book=d59f2870u874&limit=2'));
        const j = JSON.parse(await res.text());
        expect(res.status).toBe(200);
        expect(j.items).toEqual([{ v: 1, a: 'x' }, { v: 1, a: 'y' }]);
        expect(j).toMatchObject({ book: 'd59f2870u874', cursor: '6', hasMore: true });
        const u = new URL(calls[0].url);
        expect(u.searchParams.get('kind')).toBe('cellreview');
        expect(u.searchParams.get('prefix')).toBe('cr:i:d59f2870u874:');
        expect(u.searchParams.get('after')).toBe('0');
        await fn.onRequestGet(get('items=1&book=d59f2870u874&limit=2&cursor=6'));
        expect(new URL(calls[1].url).searchParams.get('after')).toBe('6');
    });
    it('GET 管理读：按 rev＋书读，末页 cursor 为空', async () => {
        respond = () => new Response(JSON.stringify({ items: [], next: null, hasMore: false }), { status: 200 });
        const j = JSON.parse(await (await fn.onRequestGet(get('rev=vol01-r1&book=d59f2870u874'))).text());
        expect(j).toMatchObject({ rev: 'vol01-r1', items: [], cursor: '', hasMore: false });
        expect(new URL(calls[0].url).searchParams.get('prefix')).toBe('cr:vol01-r1:d59f2870u874:');
    });
});
