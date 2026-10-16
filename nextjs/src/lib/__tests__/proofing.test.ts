/**
 * @jest-environment node
 */
import {
    parsePending, parseCord, resolveCrop, cropRect, pickProofingVersion, pickProofingChapter, loadProofing, submitReview,
} from '../proofing';

const pending = {
    schema: 'guji-pending/0.1', book: 'b1', vol: 'vol01', rev: 'r1',
    cells: [
        { a: '3:1:2', review: 'pending', c: '天', cand: { lib: '夭', ocr: '天' } },
        { a: '3:1:3', review: 'pending', c: '地', box: [10, 20, 30, 40] },
        { a: '3:1:4', review: 'human', c: '人' },
    ],
};
const cord = { pages: [{ page: 3, canvas: { seq: '0003', width: 1000, height: 1500 }, cells: [{ a: '3:1:2', box: [100, 200, 50, 60] }] }] };

describe('parsePending', () => {
    it('取待审格与 rev，跳过已校', () => {
        const r = parsePending(pending);
        expect(r.rev).toBe('r1');
        expect(r.cells.map(c => c.a)).toEqual(['3:1:2', '3:1:3']);
        expect(r.cells[1].box).toEqual([10, 20, 30, 40]);
        expect(r.cells[0].cand?.length).toBeGreaterThan(0);
    });
    it('坏数据不抛', () => {
        for (const bad of [null, undefined, 1, 'x', [], {}, { cells: 5 }, { rev: '../x', cells: [null, { a: 3 }, { a: '1:1:1', box: [1, 2, 'x', 4] }] }]) {
            expect(() => parsePending(bad)).not.toThrow();
        }
        expect(parsePending({ rev: '../x' }).rev).toBeNull();
        expect(parsePending({ rev: 'r', cells: [{ a: '1:1:1', review: 'pending', box: [1, 2, 0, 4] }] }).cells[0]?.box).toBeUndefined();
    });
});

describe('cord / 裁剪', () => {
    it('按 a 查框与页序；pending 的 box 优先', () => {
        const c = parseCord(cord);
        const [x, y] = parsePending(pending).cells;
        expect(resolveCrop(x, c)).toEqual({ box: [100, 200, 50, 60], seq: '0003', canvasWidth: 1000 });
        expect(resolveCrop(y, c)?.box).toEqual([10, 20, 30, 40]);
        expect(resolveCrop(x, null)).toBeNull();
        expect(resolveCrop({ a: '9:1:1' }, c)).toBeNull();
    });
    it('cord 坏数据不抛', () => {
        expect(() => parseCord({ pages: [null, { page: 'x' }, { page: 1, cells: 3 }] })).not.toThrow();
        expect(() => parseCord(null)).not.toThrow();
    });
    it('cropRect 按实际图宽换算并夹在图内', () => {
        const [x, y, w, h] = cropRect({ box: [100, 200, 50, 60], seq: '1', canvasWidth: 1000 }, 2000, 3000, 0);
        expect([x, y, w, h]).toEqual([200, 400, 100, 120]);
        const r = cropRect({ box: [0, 0, 50, 60], seq: '1', canvasWidth: 1000 }, 1000, 1500);
        expect(r[0]).toBe(0);
        expect(r[1]).toBe(0);
    });
});

describe('loadProofing', () => {
    const manifest = { versions: [{ key: 'original', proofing: true }] };
    const index = { chapters: [{ file: 'vol01.json', vol: 'vol01', pending_file: 'vol01.pending.json', cord_file: 'vol01.cord.json' }] };
    const deps = (over: Record<string, unknown> = {}) => ({
        getManifest: async () => manifest,
        getIndex: async () => index,
        getFile: async (_i: string, _k: string, f: string) => (f.includes('pending') ? pending : cord),
        ...over,
    });
    it('版本与章的挑选', () => {
        expect(pickProofingVersion(manifest)).toBe('original');
        expect(pickProofingVersion({ versions: [{ key: 'a' }] })).toBeNull();
        expect(pickProofingChapter(index, 'vol01')).not.toBeNull();
        expect(pickProofingChapter({ chapters: [{ pending_file: 'a.json', vol: 'x' }, { pending_file: 'b.json', vol: 'y' }] }, 'z')).toBeNull();
    });
    it('正常取到', async () => {
        const r = await loadProofing(deps(), 'b1', 'vol01');
        expect(r.status).toBe('ok');
    });
    it('没声明、取不到、抛错都不抛', async () => {
        expect((await loadProofing(deps({ getManifest: async () => null }), 'b1', 'vol01')).status).toBe('none');
        expect((await loadProofing(deps({ getFile: async () => null }), 'b1', 'vol01')).status).toBe('error');
        expect((await loadProofing(deps({ getIndex: async () => { throw new Error('x'); } }), 'b1', 'vol01')).status).toBe('error');
    });
    it('文件名带路径不请求', async () => {
        const bad = { chapters: [{ vol: 'vol01', pending_file: '../x.json' }] };
        expect((await loadProofing(deps({ getIndex: async () => bad }), 'b1', 'vol01')).status).toBe('none');
    });
});

describe('submitReview', () => {
    const draft = { book: 'b1', vol: 'vol01', a: '3:1:2', rev: 'r1', choice: 'char' as const, char: '天' };
    it('成功返回 null，带 aid', async () => {
        const f = jest.fn(async () => new Response(JSON.stringify({ success: true }), { status: 200 }));
        expect(await submitReview(draft, 'aid1', f as unknown as typeof fetch)).toBeNull();
        expect(JSON.parse((f.mock.calls[0] as unknown as [string, RequestInit])[1].body as string).aid).toBe('aid1');
    });
    it('429／错误体／网络错给文案，不抛', async () => {
        expect(await submitReview(draft, 'a', (async () => new Response('{}', { status: 429 })) as unknown as typeof fetch)).toMatch(/频繁/);
        expect(await submitReview(draft, 'a', (async () => new Response('{"error":"bad"}', { status: 400 })) as unknown as typeof fetch)).toBe('bad');
        expect(await submitReview(draft, 'a', (async () => { throw new Error('x'); }) as unknown as typeof fetch)).toMatch(/网络/);
    });
});
