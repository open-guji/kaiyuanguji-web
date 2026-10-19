/**
 * @jest-environment node
 *
 * GUJI-597：/api/thread。表态覆盖、回复追加、称呼与内容必填、target 形状、管理读按前缀、公开读被拒、限速独立前缀。
 */
const g = globalThis as unknown as Record<string, unknown>;
const store = new Map<string, string>();
const listCalls: Array<{ prefix?: string }> = [];
const kv = {
    async get(k: string) { const v = store.get(k); return v ? JSON.parse(v) : null; },
    async put(k: string, v: string) { store.set(k, v); },
    async list(opts: { prefix?: string; limit?: number }) {
        listCalls.push(opts);
        const all = [...store.keys()].filter((k) => k.startsWith(opts.prefix || '')).sort();
        return { keys: all.slice(0, opts.limit || 256).map((key) => ({ key })), complete: true, cursor: '' };
    },
};
const T = 'span~3:1:5~3:1:6~missing';
const base = { book_id: '96mid1ogzk', volume: '002', target: T, aid: 'aid_abcdefgh1234' };
function post(body: unknown, ip = '1.2.3.4') {
    const request = new Request('https://x/api/thread', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    (request as unknown as { eo: unknown }).eo = { clientIp: ip };
    return { request };
}
const get = (qs: string, headers: Record<string, string> = {}) => ({ request: new Request(`https://x/api/thread?${qs}`, { headers }) });
const keysOf = (p: string) => [...store.keys()].filter((k) => k.startsWith(p));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let fn: any;
beforeAll(async () => { g.FEEDBACK_KV = kv; fn = await import('../../../../edge-functions/api/thread.js'); });
beforeEach(() => { store.clear(); listCalls.length = 0; g.FEEDBACK_ADMIN_TOKEN = 'right'; });
afterEach(() => { delete g.FEEDBACK_ADMIN_TOKEN; });

describe('POST', () => {
    it('表态写 tv:<书>:<册>:<target>:<voter>，同来源改态覆盖；不存 aid、IP', async () => {
        expect((await fn.onRequestPost(post({ ...base, stance: 'agree' }))).status).toBe(200);
        expect(keysOf('tv:')[0]).toMatch(/^tv:96mid1ogzk:002:span~3:1:5~3:1:6~missing:[0-9a-f]{16}$/);
        await fn.onRequestPost(post({ ...base, stance: 'disagree' }));
        expect(keysOf('tv:')).toHaveLength(1);
        const rec = JSON.parse(store.get(keysOf('tv:')[0])!);
        expect(rec).toMatchObject({ v: 1, stance: 'disagree', target: T });
        expect(JSON.stringify(rec)).not.toContain('aid_abcdefgh1234');
        expect(JSON.stringify(rec)).not.toContain('1.2.3.4');
        await fn.onRequestPost(post({ ...base, stance: 'agree' }, '5.6.7.8'));
        expect(keysOf('tv:')).toHaveLength(2);
    });

    it('回复追加 tm:…，称呼与内容必填、有上限', async () => {
        expect((await fn.onRequestPost(post({ ...base, stance: 'reply', name: '甲', text: '原书作書' }))).status).toBe(200);
        await new Promise((r) => setTimeout(r, 2));
        await fn.onRequestPost(post({ ...base, stance: 'reply', name: '甲', text: '再补一句' }));
        expect(keysOf('tm:')).toHaveLength(2);
        expect(JSON.parse(store.get(keysOf('tm:')[0])!)).toMatchObject({ name: '甲', stance: 'reply' });
        for (const [b, field] of [
            [{ stance: 'reply', text: 'x' }, 'name'], [{ stance: 'reply', name: ' ', text: 'x' }, 'name'], [{ stance: 'reply', name: 'x'.repeat(21), text: 'x' }, 'name'],
            [{ stance: 'reply', name: 'a\nb', text: 'x' }, 'name'], [{ stance: 'reply', name: '甲' }, 'text'], [{ stance: 'reply', name: '甲', text: 'x'.repeat(501) }, 'text'],
        ] as const) {
            const res = await fn.onRequestPost(post({ ...base, ...b }));
            expect(res.status).toBe(400);
            expect(JSON.parse(await res.text()).field).toBe(field);
        }
    });

    it('target、stance、册、书不合法都 400', async () => {
        for (const target of ['span~3:1:5', 'x~3:1:5~~', 'char~3:1~~', 'span~3:1:5~3:1:6~bogus', 'char~100:7:-1~~bogus']) {
            expect((await fn.onRequestPost(post({ ...base, target, stance: 'agree' }))).status).toBe(400);
        }
        expect((await fn.onRequestPost(post({ ...base, target: 'char~100:7:-1~~', stance: 'agree' }))).status).toBe(200);
        expect((await fn.onRequestPost(post({ ...base, stance: 'like' }))).status).toBe(400);
        expect((await fn.onRequestPost(post({ ...base, volume: '', stance: 'agree' }))).status).toBe(400);
        expect((await fn.onRequestPost(post({ ...base, book_id: 'X', stance: 'agree' }))).status).toBe(400);
    });

    it('限速：每 IP 30 次，独立前缀', async () => {
        for (let i = 0; i < 30; i++) expect((await fn.onRequestPost(post({ ...base, stance: 'agree' }))).status).toBe(200);
        expect((await fn.onRequestPost(post({ ...base, stance: 'agree' }))).status).toBe(429);
        expect([...store.keys()].some((k) => k.startsWith('ratelimit:th:'))).toBe(true);
    });
});

describe('GET 管理读', () => {
    it('公开读 401；kind=vote／reply 按前缀列，可带册', async () => {
        await fn.onRequestPost(post({ ...base, stance: 'agree' }));
        await fn.onRequestPost(post({ ...base, stance: 'reply', name: '甲', text: 'x' }));
        expect((await fn.onRequestGet(get('book=96mid1ogzk'))).status).toBe(401);
        const v = JSON.parse(await (await fn.onRequestGet(get('book=96mid1ogzk&kind=vote', { Authorization: 'Bearer right' }))).text());
        expect(v.items).toHaveLength(1);
        expect(listCalls[listCalls.length - 1].prefix).toBe('tv:96mid1ogzk:');
        const r = JSON.parse(await (await fn.onRequestGet(get('book=96mid1ogzk&kind=reply&volume=002', { Authorization: 'Bearer right' }))).text());
        expect(r.items).toHaveLength(1);
        expect(listCalls[listCalls.length - 1].prefix).toBe('tm:96mid1ogzk:002:');
        expect((await fn.onRequestGet(get('book=96mid1ogzk&kind=x', { Authorization: 'Bearer right' }))).status).toBe(400);
    });
});

export {};
