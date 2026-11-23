import { collectBookGaps, gapsFileOf, insertGapNotes } from '../book-gaps';
import type { ReaderGap } from 'book-index-ui';

const gap: ReaderGap = { afterPage: 20, what: '卷九叶九、叶十', kind: '原书缺', estChars: 830, note: '〔原书此处缺卷九叶九、叶十，约 830 字〕' };
const md = '---\nx: 1\n---\n<!-- p19 -->\n甲\n<!-- p20 -->\n乙\n<!-- p21 -->\n丙\n';

describe('insertGapNotes', () => {
    it('注记行在 after_page 那页之后、下一页标记之前', () => {
        const out = insertGapNotes(md, [gap]);
        expect(out).toContain('乙\n〔原书此处缺卷九叶九、叶十，约 830 字〕\n\n<!-- p21 -->');
        expect(out.replace('〔原书此处缺卷九叶九、叶十，约 830 字〕\n\n', '')).toBe(md);
    });
    it('缺在末页之后放末尾；after_page 为 0 放第一个页标记之前；没有缺页原样', () => {
        expect(insertGapNotes(md, [{ ...gap, afterPage: 21 }]).endsWith('丙\n〔原书此处缺卷九叶九、叶十，约 830 字〕\n\n')).toBe(true);
        const z = insertGapNotes(md, [{ ...gap, afterPage: 0 }]);
        expect(z.indexOf('〔')).toBeLessThan(z.indexOf('<!-- p19 -->'));
        expect(insertGapNotes(md, [])).toBe(md);
    });
});

describe('collectBookGaps', () => {
    const storage = {
        getTextManifest: async () => ({ versions: [{ key: 'default' }] }),
        getTextIndex: async () => ({ chapters: [{ file: '008', title: '卷八' }, { file: '009', title: '卷九', gaps_file: '009.gaps.json' }, { file: '010', gaps_file: '010.gaps.json' }] }),
        getTextFile: async (_i: string, _k: string, f: string) => (f === '009.gaps.json' ? { gaps: [{ after_page: 20, what: '卷九叶九、叶十', kind: '原书缺', est_chars: 830 }] } : null),
    };
    it('只取声明了 gaps_file 的章；取不到的章略过', async () => {
        const rows = await collectBookGaps(storage, 'B');
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ chapter: '009', title: '卷九' });
        expect(rows[0].gaps[0].note).toBe('〔原书此处缺卷九叶九、叶十，约 830 字〕');
    });
    it('没有 manifest 或出错返回空数组', async () => {
        expect(await collectBookGaps({}, 'B')).toEqual([]);
        expect(await collectBookGaps({ getTextManifest: async () => { throw new Error('x'); } }, 'B')).toEqual([]);
    });
    it('gapsFileOf 只认安全文件名', () => {
        expect(gapsFileOf({ gaps_file: '009.gaps.json' })).toBe('009.gaps.json');
        expect(gapsFileOf({ gaps_file: '../x' })).toBeNull();
        expect(gapsFileOf(null)).toBeNull();
    });
});
