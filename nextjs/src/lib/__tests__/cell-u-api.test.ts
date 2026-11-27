/**
 * @jest-environment node
 *
 * 字格永久编号 u（guji-char v0.6）接口侧：cellreview／charfix／feedback 收可选的 u（双写期键不变，u 只进值）；
 * 不合法的 u 一律 400；公开意见清单两边 toPublicFix 同样带 u／ue。
 */
const g = globalThis as unknown as Record<string, unknown>;
import { installFakeInbox } from '../__fixtures__/fakeInbox';

const inbox = installFakeInbox(g);
const store = inbox.store;

function post(url: string, body: unknown, ip = '1.2.3.4') {
    const request = new Request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    (request as unknown as { eo: unknown }).eo = { clientIp: ip };
    return { request };
}
const keysOf = (p: string) => [...store.keys()].filter((k) => k.startsWith(p));
const BAD_U = [0, -1, 1.5, '12', 100_000_000, true];

/* eslint-disable @typescript-eslint/no-explicit-any */
let cr: any;
let cf: any;
let fb: any;
let fixes: any;
let sync: any;
const rl = new Map<string, string>();
const kv = {
    store: new Map<string, string>(),
    async get(k: string, t?: string) { const v = rl.get(k) ?? kv.store.get(k); if (v === undefined) return null; return t === 'json' ? JSON.parse(v) : v; },
    async put(k: string, v: string) { if (k.startsWith('ratelimit:')) rl.set(k, v); else kv.store.set(k, v); },
    async list(opts: { prefix?: string } = {}) { return { keys: [...kv.store.keys()].filter((k) => k.startsWith(opts.prefix || '')).map((key) => ({ key })), complete: true, cursor: '' }; },
};
beforeAll(async () => {
    g.FEEDBACK_KV = kv;
    cr = await import('../../../../edge-functions/api/cellreview.js');
    cf = await import('../../../../edge-functions/api/charfix.js');
    fb = await import('../../../../edge-functions/api/feedback.js');
    fixes = await import('../../../../edge-functions/api/fixes.js');
    sync = await import('../../../scripts/lib/fixes-sync.mjs');
});
beforeEach(() => { cr.resetMemRateLimit(); inbox.reset(); inbox.install(); rl.clear(); kv.store.clear(); g.FEEDBACK_ADMIN_TOKEN = 'right'; });
afterEach(() => { delete g.FEEDBACK_ADMIN_TOKEN; });
afterAll(() => { inbox.restore(); delete g.FEEDBACK_KV; });

describe('cellreview 收 u', () => {
    const base = { book: 'd59f2870u874', vol: 'vol31', a: '12:3:7', item: 'pi_0123456789ab', aid: 'aid_abcdefgh1234', choice: 'none' };
    it('带 u：键与不带时相同，u 进值', async () => {
        expect((await cr.onRequestPost(post('https://x/api/cellreview', { ...base, u: 1234 }))).status).toBe(200);
        const keys = keysOf('cr:');
        expect(keys).toHaveLength(1);
        expect(keys[0]).toMatch(/^cr:i:d59f2870u874:pi_0123456789ab:[0-9a-f]{16}$/);
        expect(JSON.parse(store.get(keys[0])!)).toMatchObject({ a: '12:3:7', u: 1234 });
    });
    it('按条目记票也带 u', async () => {
        await cr.onRequestPost(post('https://x/api/cellreview', { ...base, item: 'pi_0123456789ab', ver: 3, u: 7 }));
        expect(JSON.parse(store.get(keysOf('cr:i:')[0])!)).toMatchObject({ item: 'pi_0123456789ab', ver: 3, u: 7 });
    });
    it('不带 u（老单）照收，值里没有 u；null／空串当没带', async () => {
        for (const u of [undefined, null, '']) {
            inbox.reset();
            expect((await cr.onRequestPost(post('https://x/api/cellreview', { ...base, u }))).status).toBe(200);
            expect(JSON.parse(store.get(keysOf('cr:')[0])!)).not.toHaveProperty('u');
        }
    });
    it.each(BAD_U)('u=%p → 400，不落库', async (u) => {
        const res = await cr.onRequestPost(post('https://x/api/cellreview', { ...base, u }));
        expect(res.status).toBe(400);
        expect(keysOf('cr:')).toHaveLength(0);
    });
});

describe('charfix 收 u', () => {
    const fix = { book_id: 'd59f2870u874', volume: '002', text_version: '1.0.0', cell_id: '4:3:8a', old_char: '於', new_char: '于', aid: 'aid_abcdefgh1234' };
    const span = { kind: 'span', book_id: 'd59f2870u874', volume: '002', text_version: '1.0.0', start: '4:3:8', end: '4:3:9', sub: 'wrong', new_text: '纪昀', aid: 'aid_abcdefgh1234' };
    const ent = { kind: 'entity', book_id: 'd59f2870u874', volume: '002', chapter: '002', entity_id: 'e01384', entity_version: '1.8.12', anchor: { start: '4:3:8', end: '4:3:9' }, text: '紀昀', note: '應作紀曉嵐', aid: 'aid_abcdefgh1234' };
    it('改字带 u：键不变，u 进值', async () => {
        expect((await cf.onRequestPost(post('https://x/api/charfix', { ...fix, u: 41 }))).status).toBe(200);
        const k = keysOf('cf:');
        expect(k[0]).toMatch(/^cf:d59f2870u874:002:1\.0\.0:4:3:8a:[0-9a-f]{16}$/);
        expect(JSON.parse(store.get(k[0])!)).toMatchObject({ cell_id: '4:3:8a', u: 41 });
    });
    it('一段、专名带 u_start／u_end；只给一个拒', async () => {
        expect((await cf.onRequestPost(post('https://x/api/charfix', { ...span, u_start: 41, u_end: 42 }))).status).toBe(200);
        expect(JSON.parse(store.get(keysOf('cs:')[0])!)).toMatchObject({ start: '4:3:8', u_start: 41, u_end: 42 });
        expect((await cf.onRequestPost(post('https://x/api/charfix', { ...ent, u_start: 41, u_end: 42 }))).status).toBe(200);
        const e = JSON.parse(store.get(keysOf('ce:')[0])!);
        expect(e).toMatchObject({ anchor: { start: '4:3:8', end: '4:3:9' }, u_start: 41, u_end: 42 });
        for (const half of [{ u_start: 41 }, { u_end: 42 }]) {
            expect((await cf.onRequestPost(post('https://x/api/charfix', { ...span, ...half }, '9.9.9.9'))).status).toBe(400);
            expect((await cf.onRequestPost(post('https://x/api/charfix', { ...ent, ...half }, '9.9.9.8'))).status).toBe(400);
        }
    });
    it('不带 u 照收；坏 u 拒', async () => {
        expect((await cf.onRequestPost(post('https://x/api/charfix', fix))).status).toBe(200);
        expect(JSON.parse(store.get(keysOf('cf:')[0])!)).not.toHaveProperty('u');
        for (const u of BAD_U) {
            const res = await cf.onRequestPost(post('https://x/api/charfix', { ...fix, u }, `7.7.7.${String(u).length}`));
            expect(res.status).toBe(400);
            expect((await res.json()).field).toBe('u');
        }
    });
});

describe('feedback 收 cell 与 u', () => {
    const fbRecs = () => [...kv.store.entries()].filter(([k]) => k.startsWith('fb_')).map(([, v]) => JSON.parse(v));
    const env = () => ({ FEEDBACK_KV: kv, FEEDBACK_ADMIN_TOKEN: 'right' });
    const req = (body: unknown) => ({ ...post('https://x/api/feedback', body), env: env(), waitUntil: () => undefined });
    it('选字报错带首格格位与 u：记进反馈记录', async () => {
        expect((await fb.onRequestPost(req({ type: 'bug', content: '這段錯了', cell: '4:3:8', u: 41 }))).status).toBe(200);
        expect(fbRecs()[0]).toMatchObject({ cell: '4:3:8', u: 41 });
    });
    it('不带照旧；坏格位、坏 u 拒', async () => {
        expect((await fb.onRequestPost(req({ type: 'bug', content: '普通反馈' }))).status).toBe(200);
        expect(fbRecs()[0]).not.toHaveProperty('u');
        expect((await fb.onRequestPost(req({ type: 'bug', content: 'x', cell: 'abc' }))).status).toBe(400);
        expect((await fb.onRequestPost(req({ type: 'bug', content: 'x', u: 0 }))).status).toBe(400);
    });
});

describe('公开意见清单带 u', () => {
    it('/api/fixes 与每日清单 toPublicFix 同形，带 u／ue；老记录不带', () => {
        const recs = [
            { kind: 'char', cell_id: '2:3:4', u: 9, new_char: '輅', voter: 'a1b2c3d4e5f60718', ts: 1 },
            { kind: 'span', start: '3:1:9', end: '3:1:10', u_start: 10, u_end: 11, sub: 'missing', new_text: '卷一', voter: 'a1b2c3d4e5f60718', ts: 2 },
            { kind: 'entity', anchor: { start: '4:1:1', end: '4:1:2' }, u_start: 12, u_end: 13, text: '紀昀', note: 'x', voter: 'a1b2c3d4e5f60718', ts: 3 },
            { kind: 'char', cell_id: '5:1:1', new_char: '于', voter: 'a1b2c3d4e5f60718', ts: 4 },
        ];
        const a = recs.map(fixes.toPublicFix);
        expect(a).toEqual(recs.map(sync.toPublicFix));
        expect(a[0]).toMatchObject({ at: '2:3:4', u: 9 });
        expect(a[0]).not.toHaveProperty('ue');
        expect(a[1]).toMatchObject({ u: 10, ue: 11 });
        expect(a[2]).toMatchObject({ u: 12, ue: 13 });
        expect(a[3]).not.toHaveProperty('u');
    });
});
