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
const doc = () => ({ rev: '004-r3', sprites: [], cells: [{ cell: '1:1:1', id: 'pi_000000000001', ver: 1 }, { cell: '1:1:2', id: 'pi_000000000002', ver: 1 }] });
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
    it('写要管理令牌；doc 要有 rev 和 cells', async () => {
        expect((await fn.onRequestPost(post({ op: 'put', book: B, vol: '004', doc: doc() }, { 'Content-Type': 'application/json' }))).status).toBe(401);
        expect((await fn.onRequestPost(post({ op: 'put', book: B, vol: '004', doc: { rev: 'x' } }))).status).toBe(400);
        expect(store.size).toBe(0);
    });
    it('hide：按条目或格号撤下，进 withdrawn；unhide 放回；expect_rev 对不上 409', async () => {
        await fn.onRequestPost(post({ op: 'put', book: B, vol: '004', doc: doc() }));
        const h = await j(await fn.onRequestPost(post({ op: 'hide', book: B, vol: '004', items: ['pi_000000000001'], why: '误报', by: 'A31' })));
        expect(h).toMatchObject({ success: true, changed: 1, cells: 1 });
        const d = JSON.parse(store.get(`pd:${B}:004`)!).doc;
        expect(d.cells.map((c: { cell: string }) => c.cell)).toEqual(['1:1:2']);
        expect(d.withdrawn[0]).toMatchObject({ cell: '1:1:1', withdrawn: { by: 'A31', why: '误报' } });
        expect((await fn.onRequestPost(post({ op: 'hide', book: B, vol: '004', cells: ['1:1:2'], expect_rev: 'old' }))).status).toBe(409);
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

describe('超 900 KB 的单子压缩存放', () => {
    it('put 大单 → 存 z；公开读还原；hide 照常', async () => {
        const big = { rev: '004-r9', sprites: [], cells: Array.from({ length: 6000 }, (_, i) => ({ cell: `${i + 1}:1:1`, id: `pi_${String(i).padStart(12, '0')}`, ver: 1, note: Math.random().toString(36).repeat(8) })) };
        expect(JSON.stringify(big).length).toBeGreaterThan(900 * 1024);
        expect((await fn.onRequestPost(post({ op: 'put', book: B, vol: '004', doc: big }))).status).toBe(200);
        const stored = JSON.parse(store.get(`pd:${B}:004`)!);
        expect(stored.z).toBeTruthy();
        expect(stored.doc).toBeUndefined();
        expect(JSON.stringify(stored).length).toBeLessThan(1_400_000);
        const r = await fn.onRequestGet(get(`book=${B}&vol=004`));
        expect((await j(r)).cells).toHaveLength(6000);
        const h = await j(await fn.onRequestPost(post({ op: 'hide', book: B, vol: '004', items: ['pi_000000000001'] })));
        expect(h).toMatchObject({ success: true, changed: 1, cells: 5999 });
    });
});
