/**
 * @jest-environment node
 */
import {
    parsePending, parseCord, resolveCrop, cropRect, versionKeys, pickProofingChapter, loadProofing, submitReview,
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

describe('规范形（book-text#148）：cells 键为 cell、无 c／cand／box', () => {
    it('cell 与 a 都收，rev 原样', () => {
        const r = parsePending({ schema: 'guji-pending/0.1', rev: '001-r1', cv_version: null, cv_commit: 'abc', cells: [{ cell: '3:1:2', review: 'pending' }, { a: '3:1:3', review: 'pending' }] });
        expect(r.rev).toBe('001-r1');
        expect(r.cells.map(c => c.a)).toEqual(['3:1:2', '3:1:3']);
    });
    it('机器读字从 char_file 补', async () => {
        const char = { version: '1.0.0', book_id: 'b', volume: 1, pages: [{ page: 3, columns: [{ col: 1, cells: [{ a: '3:1:1', c: '欽' }, { a: '3:1:2', c: '定' }] }] }] };
        const idx = { chapters: [{ vol: '001', proofing: true, pending_file: '001.pending.json', char_file: '001.char.json', cord_file: '001.cord.json' }] };
        const r = await loadProofing({
            getManifest: async () => ({ versions: [{ key: 'original' }] }),
            getIndex: async () => idx,
            getFile: async (_i, _k, f) => (f.includes('pending') ? { rev: '001-r1', cells: [{ cell: '3:1:2', review: 'pending' }] } : f.includes('char') ? char : { pages: [{ page: 3, canvas: { seq: '0003', width: 100 }, cells: [] }] }),
        }, 'b', '001');
        expect(r.status).toBe('ok');
        if (r.status === 'ok') expect(r.pending.cells[0].c).toBe('定');
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
    const manifest = { versions: [{ key: 'default' }, { key: 'original' }] };
    const index = { chapters: [{ file: 'vol01.json', vol: 'vol01', proofing: true, pending_file: 'vol01.pending.json', cord_file: 'vol01.cord.json' }] };
    const deps = (over: Record<string, unknown> = {}) => ({
        getManifest: async () => manifest,
        getIndex: async () => index,
        getFile: async (_i: string, _k: string, f: string) => (f.includes('pending') ? pending : cord),
        ...over,
    });
    it('版本与章的挑选', () => {
        expect(versionKeys(manifest)).toEqual(['original', 'default']);
        expect(versionKeys(null)).toEqual([]);
        expect(pickProofingChapter(index, 'vol01')).not.toBeNull();
        expect(pickProofingChapter({ chapters: [{ proofing: true, pending_file: 'a.json', vol: 'x' }, { proofing: true, pending_file: 'b.json', vol: 'y' }] }, 'z')).toBeNull();
        // 没有 proofing: true 就不算
        expect(pickProofingChapter({ chapters: [{ pending_file: 'a.json', vol: 'vol01' }] }, 'vol01')).toBeNull();
    });
    it('正常取到', async () => {
        const r = await loadProofing(deps(), 'b1', 'vol01');
        expect(r.status).toBe('ok');
    });
    it('没声明、取不到、抛错都不抛', async () => {
        expect((await loadProofing(deps({ getManifest: async () => null }), 'b1', 'vol01')).status).toBe('none');
        expect((await loadProofing(deps({ getFile: async () => null }), 'b1', 'vol01')).status).toBe('error');
        expect((await loadProofing(deps({ getIndex: async () => { throw new Error('x'); } }), 'b1', 'vol01')).status).toBe('none');
        // 第一个版本目录抛错，第二个版本照样能取到
        let n = 0;
        expect((await loadProofing(deps({ getIndex: async () => { if (n++ === 0) throw new Error('x'); return index; } }), 'b1', 'vol01')).status).toBe('ok');
    });
    it('文件名带路径不请求', async () => {
        const bad = { chapters: [{ vol: 'vol01', proofing: true, pending_file: '../x.json' }] };
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

describe('真实 guji-cord 形状（96mid1ogzk vol02 第 3 页节选）', () => {
    const real = {
        $schema: 'https://open-guji.org/schema/cord/v0.1.json', book_id: '96mid1ogzk', volume: 2,
        pages: [
            { page: 1, image: { width: 957, height: 1359 }, canvas: { id: 'https://data.kaiyuanguji.com/iiif/96mid1ogzk/canvas/02/0001', seq: '0001', width: 957, height: 1359 }, cells: [] },
            { page: 3, image: { width: 2345, height: 3122 }, canvas: { id: 'https://data.kaiyuanguji.com/iiif/96mid1ogzk/canvas/02/0003', seq: '0003', width: 2345, height: 3122 },
              cells: [{ a: '3:1:1', box: [1862, 332, 163, 128], id: 'gdgzygfc5gy' }, { a: '3:1:2', box: [1858, 451, 163, 131], id: 'gmzn45qh7xw' }],
              marks: [{ kind: 'blank', slot: 3, col: 1, box: [1, 2, 3, 4] }] },
        ],
    };
    it('取到 xywh 框、四位 seq 字符串与 canvas 宽', () => {
        const c = parseCord(real);
        expect(c.boxes.get('3:1:2')).toEqual([1858, 451, 163, 131]);
        expect(c.pages.get(3)).toEqual({ seq: '0003', width: 2345 });
        expect(resolveCrop({ a: '3:1:1' }, c)).toEqual({ box: [1862, 332, 163, 128], seq: '0003', canvasWidth: 2345 });
    });
    it('marks 里的非字格不当作字格', () => {
        expect(parseCord(real).boxes.size).toBe(2);
    });
});
