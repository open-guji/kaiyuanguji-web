/**
 * @jest-environment node
 */
jest.mock('book-index-ui', () => ({ setImageSourceResolver: jest.fn() }));
import { affineOf, applyH, commonsImageUrl, invert3, parseWarpUrl, validCommons, warpTriangles } from '../commons-warp';
import { canvasesToImages } from '../facsimile';

// 页表 96mid1ogzk/05/r004 第 0001 页（右半叶）算出的矩阵，见 ops/tests/test_commons_warp.py
const M = [0.8, 0.01, -2800, -0.005, 0.8, -2580, 0, 0, 1];
const COMMONS = {
    url: 'https://upload.wikimedia.org/wikipedia/commons/thumb/8/80/x.djvu/page234-3840px-x.djvu.jpg',
    width: 3840, height: 5420, matrix: M,
};

describe('commons-warp', () => {
    it('invert3 与 applyH 互逆', () => {
        const [x, y] = applyH(invert3(M), ...applyH(M, 3000, 3500));
        expect(x).toBeCloseTo(3000, 6);
        expect(y).toBeCloseTo(3500, 6);
    });

    it('affineOf：三点对应', () => {
        const [a, b, c, d, e, f] = affineOf([[0, 0], [10, 0], [0, 10]], [[5, 5], [25, 5], [5, 35]]);
        expect([a, b, c, d, e, f].map(v => Math.round(v * 1e6) / 1e6)).toEqual([2, 0, 0, 3, 5, 5]);
    });

    it('warpTriangles：覆盖整页，三角顶点按矩阵对应', () => {
        const tris = warpTriangles(M, 1824, 2575, 4, 4);
        expect(tris).toHaveLength(32);
        const t = tris[0];
        const [x, y] = applyH(M, t.src[1][0], t.src[1][1]);
        expect(x).toBeCloseTo(t.dst[1][0], 6);
        expect(y).toBeCloseTo(t.dst[1][1], 6);
    });

    it('地址往返；非 Wikimedia 地址不认', () => {
        const url = commonsImageUrl(COMMONS, 1824, 2575, 'https://data.openguji.com/iiif/a/05/0001/full/1200,/0/default.webp');
        const s = parseWarpUrl(url)!;
        expect(s.matrix).toEqual(M);
        expect([s.w, s.h]).toEqual([1824, 2575]);
        expect(s.fb).toContain('data.openguji.com');
        expect(s.src).toBe(COMMONS.url);
        expect(parseWarpUrl('https://x/y.jpg')).toBeNull();
        expect(validCommons({ ...COMMONS, url: 'https://evil.example/x.jpg' })).toBe(false);
        expect(validCommons({ ...COMMONS, matrix: [1] })).toBe(false);
    });

    it('canvasesToImages：只在海外且 canvas 带矩阵时换 Commons', () => {
        const canvas = {
            id: 'c', width: 1824, height: 2575, 'bim:commons': COMMONS,
            items: [{ items: [{ body: { items: [{ id: 'https://data.openguji.com/iiif/96mid1ogzk/05/0001/full/1200,/0/default.webp' }] } }] }],
        };
        const own = canvasesToImages([canvas as any]);
        expect(own[0].url).toContain('data.openguji.com');
        const cm = canvasesToImages([canvas as any], { commons: true });
        expect(cm[0].url.startsWith(COMMONS.url + '#bimwarp=')).toBe(true);
        expect(cm[0].hiresUrl).toBe(cm[0].url);
        expect(cm[0].seq).toBe('0001');
        expect(cm[0].alt).toContain('Wikimedia Commons');
        const none = canvasesToImages([{ ...canvas, 'bim:commons': undefined } as any], { commons: true });
        expect(none[0].url).toContain('data.openguji.com');
    });
});
