/**
 * @jest-environment node
 *
 * /api/pending：待审单直读（KV 整张单）。公开读、管理写（put／hide／unhide／delete）。
 */
const g = globalThis as unknown as Record<string, unknown>;
import { installFakeInbox } from '../__fixtures__/fakeInbox';
const inbox = installFakeInbox(g);
const store = inbox.store;
const ADMIN = { Authorization: 'Bearer right', 'Content-Type': 'application/json' };
const B = 'd59f2870u874';
const post = (body: unknown, headers: Record<string, string> = ADMIN) => ({ request: new Request('https://x/api/pending', { method: 'POST', headers, body: JSON.stringify(body) }) });
const get = (qs: string) => ({ request: new Request(`https://x/api/pending?${qs}`) });
const doc = () => ({ sprites: [], cells: [{ cell: '1:1:1', id: 'pi_000000000001', ver: 1 }, { cell: '1:1:2', id: 'pi_000000000002', ver: 1 }] });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let fn: any;
beforeAll(async () => { fn = await import('../../../../edge-functions/api/pending.js'); });
beforeEach(() => { inbox.reset(); inbox.install(); g.FEEDBACK_ADMIN_TOKEN = 'right'; });
afterEach(() => { delete g.FEEDBACK_ADMIN_TOKEN; });
afterAll(() => inbox.restore());
const j = async (r: Response) => JSON.parse(await r.text());

describe('/api/pending', () => {
    it('公开读：没有 404，有则原样返回并短缓存', async () => {
        expect((await fn.onRequestGet(get(`book=${B}&vol=004`))).status).toBe(404);
        await fn.onRequestPost(post({ op: 'put', book: B, vol: '004', doc: doc() }));
        const r = await fn.onRequestGet(get(`book=${B}&vol=004`));
        expect(r.status).toBe(200);
        expect(r.headers.get('Cache-Control')).toBe('public, max-age=15');
        expect((await j(r)).cells).toHaveLength(2);
        expect((await fn.onRequestGet(get('book=!!&vol=004'))).status).toBe(400);
    });
    it('写要管理令牌；doc 要有 cells（没有 rev）', async () => {
        expect((await fn.onRequestPost(post({ op: 'put', book: B, vol: '004', doc: doc() }, { 'Content-Type': 'application/json' }))).status).toBe(401);
        expect((await fn.onRequestPost(post({ op: 'put', book: B, vol: '004', doc: { sprites: [] } }))).status).toBe(400);
        expect(store.size).toBe(0);
    });
    it('hide：按条目或格号撤下，进 withdrawn；unhide 放回；没有 rev／expect_rev', async () => {
        await fn.onRequestPost(post({ op: 'put', book: B, vol: '004', doc: doc() }));
        const h = await j(await fn.onRequestPost(post({ op: 'hide', book: B, vol: '004', items: ['pi_000000000001'], why: '误报', by: 'A31' })));
        expect(h).toMatchObject({ success: true, changed: 1, cells: 1 });
        const d = JSON.parse(store.get(`pd:${B}:004`)!).doc;
        expect(d.cells.map((c: { cell: string }) => c.cell)).toEqual(['1:1:2']);
        expect(d.withdrawn[0]).toMatchObject({ cell: '1:1:1', withdrawn: { by: 'A31', why: '误报' } });
        const u = await j(await fn.onRequestPost(post({ op: 'unhide', book: B, vol: '004', cells: ['1:1:1'] })));
        expect(u).toMatchObject({ changed: 1, cells: 2 });
        const d2 = JSON.parse(store.get(`pd:${B}:004`)!).doc;
        expect(d2.withdrawn).toBeUndefined();
        expect(d2.cells.find((c: { cell: string }) => c.cell === '1:1:1').withdrawn).toBeUndefined();
    });
    it('delete 删掉；hide 在没有单时 404', async () => {
        expect((await fn.onRequestPost(post({ op: 'hide', book: B, vol: '004', cells: ['1:1:1'] }))).status).toBe(404);
        await fn.onRequestPost(post({ op: 'put', book: B, vol: '004', doc: doc() }));
        await fn.onRequestPost(post({ op: 'delete', book: B, vol: '004' }));
        expect(store.size).toBe(0);
    });
});

describe('读时现算（Worker /v1/web/pending-live）', () => {
    const put = () => fn.onRequestPost(post({ op: 'put', book: B, vol: '004', doc: { ...doc(), items: { file: 'x', n: { open: 2, withdrawn: 0 } } } }));
    it('已落定、已撤下的条目从 cells 拿掉，没落定的挂 AI 摘要；存的单不动', async () => {
        await put();
        inbox.liveBox.reply = () => ({ found: true, at: 't', hide: { pi_000000000001: 'verdict' }, ai: { pi_000000000002: { c: '曰', s: '文意：曰', k: 'high' } } });
        const d = await j(await fn.onRequestGet(get(`book=${B}&vol=004`)));
        expect(d.cells.map((c: { id: string }) => c.id)).toEqual(['pi_000000000002']);
        expect(d.cells[0].ai).toEqual({ c: '曰', s: '文意：曰', k: 'high' });
        expect(d.live).toEqual({ at: 't', hidden: 1, ai: 1, of: 2 });
        expect(d.items.n.open).toBe(1);
        expect(JSON.parse(store.get(`pd:${B}:004`)!).doc.cells).toHaveLength(2);
    });
    it('Worker 没这个接口、报错、说这章没有条目：原样给整张单，不挡读者', async () => {
        await put();
        for (const reply of [null, 500, () => ({ found: false, at: 't' })] as const) {
            inbox.liveBox.reply = reply as never;
            const d = await j(await fn.onRequestGet(get(`book=${B}&vol=004`)));
            expect(d.cells).toHaveLength(2);
            expect(d.live).toBeUndefined();
        }
    });
    it('?live=0 不问 Worker', async () => {
        await put();
        inbox.liveBox.reply = () => ({ found: true, at: 't', hide: { pi_000000000001: 'verdict' } });
        const d = await j(await fn.onRequestGet(get(`book=${B}&vol=004&live=0`)));
        expect(d.cells).toHaveLength(2);
    });
});

describe('超 900 KB 的单子分块存放', () => {
    it('put 大单 → 主行＋续块；公开读拼回；hide 照常；改小后续块删掉；delete 全删', async () => {
        const big = { sprites: [], cells: Array.from({ length: 12000 }, (_, i) => ({ cell: `${i + 1}:1:1`, id: `pi_${String(i).padStart(12, '0')}`, ver: 1, note: Math.random().toString(36).repeat(8) })) };
        expect(JSON.stringify(big).length).toBeGreaterThan(1_800 * 1024);
        expect((await fn.onRequestPost(post({ op: 'put', book: B, vol: '004', doc: big }))).status).toBe(200);
        const main = JSON.parse(store.get(`pd:${B}:004`)!);
        expect(main.parts).toBeGreaterThanOrEqual(2);
        expect(store.has(`pd:${B}:004~p1`)).toBe(true);
        const r = await fn.onRequestGet(get(`book=${B}&vol=004`));
        expect((await j(r)).cells).toHaveLength(12000);
        const h = await j(await fn.onRequestPost(post({ op: 'hide', book: B, vol: '004', items: ['pi_000000000001'] })));
        expect(h).toMatchObject({ success: true, changed: 1, cells: 11999 });
        expect((await fn.onRequestPost(post({ op: 'put', book: B, vol: '004', doc: doc() }))).status).toBe(200);
        expect(store.has(`pd:${B}:004~p1`)).toBe(false);
        expect((await j(await fn.onRequestGet(get(`book=${B}&vol=004`)))).cells).toHaveLength(2);
        await fn.onRequestPost(post({ op: 'put', book: B, vol: '004', doc: big }));
        await fn.onRequestPost(post({ op: 'delete', book: B, vol: '004' }));
        expect(store.size).toBe(0);
    });
});

describe('/api/pending-index：各章现算后的剩余格数', () => {
    let idx: any; // eslint-disable-line @typescript-eslint/no-explicit-any
    beforeAll(async () => { idx = await import('../../../../edge-functions/api/pending-index.js'); });
    const getI = (qs: string) => ({ request: new Request(`https://x/api/pending-index?${qs}`) });
    it('回 Worker 现算的各章格数并缓存 30 秒；书号坏 400；Worker 读不到 503 不缓存', async () => {
        const realFetch = g.fetch as typeof fetch;
        g.fetch = async (input: unknown) => {
            const u = new URL(String(input));
            if (u.pathname === '/v1/web/pending-live-index') return new Response(JSON.stringify({ book: u.searchParams.get('book'), at: 't', counts: { '001': 3, '002': 0 } }), { status: 200 });
            return new Response('{}', { status: 404 });
        };
        const r = await idx.onRequestGet(getI(`book=${B}`));
        expect(r.status).toBe(200);
        expect(r.headers.get('Cache-Control')).toBe('public, max-age=30');
        expect((await j(r)).counts).toEqual({ '001': 3, '002': 0 });
        expect((await idx.onRequestGet(getI('book=!!'))).status).toBe(400);
        g.fetch = async () => new Response('{}', { status: 500 });
        const bad = await idx.onRequestGet(getI(`book=${B}`));
        expect(bad.status).toBe(503);
        expect(bad.headers.get('Cache-Control')).toBe('no-store');
        g.fetch = realFetch;
    });
});
