import { runCompare } from '../run';

jest.mock('../variants', () => ({ loadVariantTest: async () => null }));
import { buildDecorations, countByCat, itemByAnchor, stepItem, visibleItems } from '../decorate';
import { DEFAULT_COMPARE_PREFS, parseComparePrefs } from '../prefs';
import type { CompareItem } from '../compare';

const mkItem = (o: Partial<CompareItem> & Pick<CompareItem, 'id' | 'cat' | 'type' | 'i1' | 'i2'>): CompareItem => ({
    anchor: { start: '', end: '' }, base: '', reading: '', ctx: { base: ['', ''], reading: ['', ''] }, volNo: 1, ...o,
});
const cells = ['天', '地', '玄', '黃', '宇'].map((c, i) => ({ c, a: `1:1:${i + 1}` }));

describe('buildDecorations', () => {
    const items = [
        mkItem({ id: 'v1', cat: 'word', type: 'sub', i1: 1, i2: 3, base: '地玄', reading: '坤元' }),
        mkItem({ id: 'v2', cat: 'add', type: 'ins', i1: 4, i2: 4, reading: '宙' }),
        mkItem({ id: 'v3', cat: 'glyph', type: 'sub', i1: 0, i2: 1, base: '天', reading: '天' }),
    ];
    it('对照写法放下标在这一处最后一字上，增的挂在前一字后；异体字默认不显示', () => {
        const m = buildDecorations(items, cells, DEFAULT_COMPARE_PREFS);
        expect(m.get('1:1:1')).toBeUndefined();
        expect(m.get('1:1:2')).toMatchObject({ tone: 'cmp-word' });
        expect(m.get('1:1:2')?.sub).toBeUndefined();
        expect(m.get('1:1:3')).toMatchObject({ tone: 'cmp-word', sub: '坤元' });
        expect(m.get('1:1:4')).toMatchObject({ tone: 'cmp-ins', insertAfter: '宙' });
    });
    it('开异体字、简洁模式、焦点', () => {
        const m = buildDecorations(items, cells, { cats: { ...DEFAULT_COMPARE_PREFS.cats, glyph: true }, mode: 'simple' }, 'v1');
        expect(m.get('1:1:1')).toMatchObject({ tone: 'cmp-glyph' });
        expect(m.get('1:1:3')?.sub).toBeUndefined();
        expect(m.get('1:1:4')?.insertAfter).toBeUndefined();
        expect(m.get('1:1:4')?.underline).toBe('solid');
        expect(m.get('1:1:2')?.focus).toBe(true);
    });
    it('统计、按格位找条目、上一处下一处', () => {
        expect(countByCat(items)).toEqual({ glyph: 1, word: 1, add: 1, omit: 0, struct: 0 });
        const by = itemByAnchor(items, cells);
        expect(by.get('1:1:3')?.id).toBe('v1');
        expect(by.get('1:1:4')?.id).toBe('v2');
        const shown = visibleItems(items, DEFAULT_COMPARE_PREFS);
        expect(stepItem(shown, null, 1)?.id).toBe('v1');
        expect(stepItem(shown, 'v1', 1)?.id).toBe('v2');
        expect(stepItem(shown, 'v2', 1)?.id).toBe('v1');
        expect(stepItem(shown, 'v1', -1)?.id).toBe('v2');
        expect(stepItem([], null, 1)).toBeNull();
    });
});

describe('parseComparePrefs', () => {
    it('缺省、坏数据回默认；部分字段按默认补', () => {
        expect(parseComparePrefs(null)).toEqual(DEFAULT_COMPARE_PREFS);
        expect(parseComparePrefs('{bad')).toEqual(DEFAULT_COMPARE_PREFS);
        expect(parseComparePrefs('{"cats":{"glyph":true},"mode":"simple"}')).toEqual({ cats: { ...DEFAULT_COMPARE_PREFS.cats, glyph: true }, mode: 'simple' });
    });
});

describe('runCompare', () => {
    const baseCells = Array.from('卷端天地玄黃').map((c, i) => ({ c, a: `1:1:${i + 1}` }));
    const transport = {
        getTextManifest: async () => ({ versions: [{ key: 'wikisource' }] }),
        getTextIndex: async (id: string) =>
            id === 'base'
                ? { chapters: [
                    { file: '001', headings: [{ level: 1, label: '卷一', anchor: '1:1:1' }] },
                    { file: '002', headings: [{ level: 1, label: '卷二', anchor: '1:1:1' }] },
                ] }
                : { chapters: [{ file: '005', title: '卷001' }, { file: '006', title: '卷002' }] },
        getChapter: async (_id: string, _k: string, f: string) => ({ md: f === '006' ? '## 卷002\n\n天地元黃\n' : null }),
    };
    it('取目录与对照本 md 比对', async () => {
        const r = await runCompare({ transport, base: { id: 'base', key: 'default', chapter: '002' }, target: { id: 'wiki' }, cells: baseCells });
        expect(r.targetKey).toBe('wikisource');
        expect(r.segments[0]).toMatchObject({ no: 2, status: 'ok', wikiFile: '006' });
        expect(r.items.map((i) => [i.cat, i.base, i.reading])).toEqual([['omit', '卷端', ''], ['word', '玄', '元']]);
    });
    it('对照本目录取不到抛错', async () => {
        await expect(runCompare({ transport: { ...transport, getTextIndex: async (id: string) => (id === 'base' ? { chapters: [] } : null) }, base: { id: 'base', key: 'default', chapter: '002' }, target: { id: 'wiki' }, cells: baseCells })).rejects.toThrow('no-target');
    });
});
