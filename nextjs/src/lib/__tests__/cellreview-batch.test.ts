/**
 * @jest-environment node
 *
 * /api/cellreview-batch：跨册聚类页一次提交几十格。逐项校验、逐项成败，落的票与 /api/cellreview 同键同形。
 */
const g = globalThis as unknown as Record<string, unknown>;
const store = new Map<string, string>();
const kv = {
    async get(k: string) { const v = store.get(k); return v ? JSON.parse(v) : null; },
    async put(k: string, v: string) { if (k.includes(':9:9:9:')) throw new Error('boom'); store.set(k, v); },
    async list() { return { keys: [], complete: true, cursor: '' }; },
};
const BOOK = 'd59f2870u874';
const item = (a: string, extra: Record<string, unknown> = {}) => ({ book: BOOK, vol: 'vol20', a, rev: '020-r5', choice: 'char', char: '兀', pick_src: 'cluster', ...extra });
function post(body: unknown, ip = '1.2.3.4') {
    const request = new Request('https://x/api/cellreview-batch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    (request as unknown as { eo: unknown }).eo = { clientIp: ip };
    return { request };
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let fn: any; let single: any;
beforeAll(async () => {
    g.FEEDBACK_KV = kv;
    fn = await import('../../../../edge-functions/api/cellreview-batch.js');
    single = await import('../../../../edge-functions/api/cellreview.js');
});
beforeEach(() => { single.resetMemRateLimit(); store.clear(); });

describe('POST 成批', () => {
    it('每项落一张票，键与单格提交相同，pick_src=cluster 保留', async () => {
        const res = await fn.onRequestPost(post({ aid: 'aid_abcdefgh1234', items: [item('1:1:1'), item('2:1:2')] }));
        const out = JSON.parse(await res.text());
        expect(out).toMatchObject({ success: true, saved: 2, failed: 0 });
        const keys = [...store.keys()];
        expect(keys).toHaveLength(2);
        expect(keys[0]).toMatch(/^cr:020-r5:d59f2870u874:1:1:1:[0-9a-f]{16}$/);
        const rec = JSON.parse(store.get(keys[0])!);
        expect(rec).toMatchObject({ v: 1, vol: '020', a: '1:1:1', choice: 'char', char: '兀', pick_src: 'cluster' });
        expect(JSON.stringify(rec)).not.toContain('aid_abcdefgh1234');
        // 单格提交同一格同一人 → 覆盖同一个键
        await single.onRequestPost(post({ ...item('1:1:1'), aid: 'aid_abcdefgh1234', char: '亣' }));
        expect([...store.keys()]).toHaveLength(2);
    });
    it('逐项成败：校验不过的、存失败的只标那一项，别的照存', async () => {
        const res = await fn.onRequestPost(post({ aid: 'aid_abcdefgh1234', items: [item('1:1:1'), item('2:1:2', { char: '兀兀' }), item('9:9:9'), item('3:1:1', { choice: 'cut' })] }));
        const out = JSON.parse(await res.text());
        expect(out.success).toBe(false);
        expect(out.saved).toBe(2);
        expect(out.results.map((r: { ok: boolean }) => r.ok)).toEqual([true, false, false, true]);
        expect(out.results[1].error).toMatch(/char/);
        expect([...store.keys()]).toHaveLength(2);
    });
    it('items 为空、超过 50 项、不是数组都 400；aid 无效每项都不收', async () => {
        for (const items of [[], Array.from({ length: 51 }, (_, i) => item(`${i + 1}:1:1`)), 'x']) {
            expect((await fn.onRequestPost(post({ aid: 'aid_abcdefgh1234', items }))).status).toBe(400);
        }
        const out = JSON.parse(await (await fn.onRequestPost(post({ aid: 'x', items: [item('1:1:1')] }))).text());
        expect(out.saved).toBe(0);
        expect(out.results[0].error).toMatch(/aid/);
        expect(store.size).toBe(0);
    });
    it('限速：一次批量算一次，同一 IP 第 121 次起 429', async () => {
        for (let i = 0; i < 120; i++) expect((await fn.onRequestPost(post({ aid: 'aid_abcdefgh1234', items: [item('1:1:1')] }))).status).toBe(200);
        expect((await fn.onRequestPost(post({ aid: 'aid_abcdefgh1234', items: [item('1:1:1')] }))).status).toBe(429);
    });
});
