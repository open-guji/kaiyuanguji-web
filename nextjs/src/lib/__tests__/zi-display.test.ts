/**
 * @jest-environment node
 *
 * 显示不出来的字改显示码位（lib/zi-display）：区段表与 globals.css 的字体 unicode-range 对账，免得加了字体忘了改表。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SHOWABLE_RANGES, canShow, cpLabel, shownZi } from '../zi-display';

/** globals.css 里所有 @font-face 的 unicode-range（只取 U+3400 以上的汉字段），合并相邻段 */
function cssRanges(): [number, number][] {
    const css = readFileSync(join(__dirname, '../../app/globals.css'), 'utf-8');
    const out: [number, number][] = [];
    for (const m of css.matchAll(/unicode-range:\s*([^;]+);/g)) {
        for (const part of m[1].split(',')) {
            const [a, b] = part.trim().replace(/^U\+/i, '').split('-');
            const lo = parseInt(a, 16);
            const hi = parseInt(b ?? a, 16);
            if (lo >= 0x3400) out.push([lo, hi]);
        }
    }
    out.sort((x, y) => x[0] - y[0]);
    const merged: [number, number][] = [];
    for (const r of out) {
        const last = merged[merged.length - 1];
        if (last && r[0] <= last[1] + 1) last[1] = Math.max(last[1], r[1]);
        else merged.push([...r]);
    }
    return merged;
}

describe('zi-display', () => {
    it('区段表＝globals.css 字体声明的区段＋基本区（系统字体）', () => {
        const expected = [...cssRanges(), [0x4e00, 0x9fff] as [number, number]].sort((x, y) => x[0] - y[0]);
        expect(SHOWABLE_RANGES.map(r => [...r])).toEqual(expected);
    });

    it('能显示的照常显示；扩 G／H／I、扩 A 与扩 B 新补的尾巴、私用区显示码位', () => {
        for (const c of ['之', '㐀', '𠀀', '𪜀', '𫝀', '𬺰', '豈', '□', 'a', '，']) expect(shownZi(c)).toBe(c);
        expect(shownZi('\u{30000}')).toBe('U+30000');     // 扩 G
        expect(shownZi('\u{31350}')).toBe('U+31350');     // 扩 H
        expect(shownZi('\u{2EBF0}')).toBe('U+2EBF0');     // 扩 I
        expect(shownZi('䶶')).toBe('U+4DB6');         // 扩 A Unicode 13 补的，花园明朝没有
        expect(shownZi('\u{2A6D7}')).toBe('U+2A6D7');     // 扩 B 尾巴
        expect(shownZi('')).toBe('U+E000');         // 私用区
        expect(canShow('之乎')).toBe(true);               // 不是单个码点：不管
        expect(cpLabel('之')).toBe('U+4E4B');
    });
});
