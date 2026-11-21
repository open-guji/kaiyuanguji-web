/**
 * @jest-environment node
 *
 * /api/inbox-backfill：管理 token、按前缀分页读 KV、一次请求只向 Worker 发 1 次、原键原 ts 原值。
 */
const g = globalThis as unknown as Record<string, unknown>;
const store = new Map<string, string>();
const kv = {
    async get(k: string) { const v = store.get(k); return v ? JSON.parse(v) : null; },
    async put(k: string, v: string) { store.set(k, v); },
    async list(opts: { prefix?: string; limit?: number; cursor?: string }) {
        const all = [...store.keys()].filter((k) => k.startsWith(opts.prefix || '')).sort();
        const start = opts.cursor ? all.findIndex((k) => k > opts.cursor!) : 0;
        const slice = start < 0 ? [] : all.slice(start, start + (opts.limit || 256));
        const complete = start < 0 || start + slice.length >= all.length;
        return { keys: slice.map((key) => ({ key })), complete, cursor: complete ? '' : slice[slice.length - 1] };
    },
};
const calls: Array<{ url: string; body: { items: Array<{ kind: string; key: string; ts?: number }> } }> = [];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let fn: any;
const realFetch = globalThis.fetch;
beforeAll(async () => {
    g.FEEDBACK_KV = kv;
    fn = await import('../../../../edge-functions/api/inbox-backfill.js');
});
afterAll(() => { g.fetch = realFetch; });
beforeEach(() => {
    store.clear(); calls.length = 0;
    g.FEEDBACK_ADMIN_TOKEN = 'right';
    g.fetch = async (url: string, init: RequestInit) => { calls.push({ url, body: JSON.parse(init.body as string) }); return new Response('{}', { status: 201 }); };
});
afterEach(() => { delete g.FEEDBACK_ADMIN_TOKEN; });

const post = (body: unknown, token = 'right') => ({
    request: new Request('https://x/api/inbox-backfill', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
});

it('无管理 token：401／403，不请求 Worker', async () => {
    const res = await fn.onRequestPost(post({ prefix: 'cr:' }, 'wrong'));
    expect([401, 403]).toContain(res.status);
    expect(calls).toHaveLength(0);
});
it('prefix 非法：400', async () => {
    expect((await fn.onRequestPost(post({ prefix: 'ratelimit:' }))).status).toBe(400);
});
it('按前缀分页，每页只发 1 次，原键原 ts', async () => {
    for (let i = 0; i < 5; i += 1) store.set(`tv:b:v:char~1:2:3~~wrong:v${i}`, JSON.stringify({ v: 1, book_id: 'b', ts: 100 + i }));
    store.set('cr:r:b:1:2:3:x', JSON.stringify({ v: 1, ts: 1 }));
    const r1 = JSON.parse(await (await fn.onRequestPost(post({ prefix: 'tv:', limit: 3 }))).text());
    expect(r1).toMatchObject({ scanned: 3, sent: 3, hasMore: true });
    const r2 = JSON.parse(await (await fn.onRequestPost(post({ prefix: 'tv:', limit: 3, cursor: r1.cursor }))).text());
    expect(r2).toMatchObject({ scanned: 2, sent: 2, hasMore: false });
    expect(calls).toHaveLength(2);
    expect(calls[0].body.items[0]).toMatchObject({ kind: 'thread', key: 'tv:b:v:char~1:2:3~~wrong:v0', ts: 100 });
});
it('dry：不请求 Worker', async () => {
    store.set('cf:a:b:c:d:e', JSON.stringify({ v: 1, ts: 1 }));
    const r = JSON.parse(await (await fn.onRequestPost(post({ prefix: 'cf:', dry: true }))).text());
    expect(r).toMatchObject({ dry: true, would_send: 1 });
    expect(calls).toHaveLength(0);
});
