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
        expect(m.get('1:1:2')).toMatchObject({ fg: 'var(--cmp-word)' });
        expect(m.get('1:1:2')?.sub).toBeUndefined();
        expect(m.get('1:1:3')).toMatchObject({ fg: 'var(--cmp-word)', sub: '坤元' });
        expect(m.get('1:1:4')).toMatchObject({ insertAfter: '宙' });
    });
    it('开异体字、简洁模式、焦点', () => {
        const m = buildDecorations(items, cells, { cats: { ...DEFAULT_COMPARE_PREFS.cats, glyph: true }, mode: 'simple' }, 'v1');
        expect(m.get('1:1:1')).toMatchObject({ fg: 'var(--cmp-glyph)' });
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
