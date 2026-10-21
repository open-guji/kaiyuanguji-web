/**
 * @jest-environment node
 *
 * 显示不出来的字改显示码位（lib/zi-display）：区段表与 zi-fonts.css 的字体 unicode-range 对账，免得改了字体忘了重生成表。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SHOWABLE_RANGES, canShow, cpLabel, shownZi } from '../zi-display';

/** zi-fonts.css、globals.css 里所有 @font-face 的 unicode-range（只取 U+3400 以上的汉字段）＋基本区（系统字体），合并相邻段 */
function cssRanges(): [number, number][] {
    const css = ['zi-fonts.css', 'globals.css'].map((f) => readFileSync(join(__dirname, '../../app', f), 'utf-8')).join('\n');
    const out: [number, number][] = [[0x4e00, 0x9fff]];
    for (const m of css.matchAll(/unicode-range:\s*([^;}]+)[;}]/g)) {
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
    it('区段表＝字体声明的区段＋基本区（系统字体）', () => {
        expect(SHOWABLE_RANGES.map(r => [...r])).toEqual(cssRanges());
    });

    it('能显示的照常显示（含扩 G–J、扩 A／B 新补的尾巴）；Jigmo 缺的、私用区显示码位', () => {
        for (const c of ['之', '㐀', '䶶', '𠀀', '\u{2A6D7}', '𪜀', '𫝀', '𬺰', '\u{2EBF0}', '\u{30000}', '\u{31350}', '\u{323B0}', '豈', '□', 'a', '，']) expect(shownZi(c)).toBe(c);
        expect(shownZi('\u{2B81E}')).toBe('U+2B81E');     // 扩 D 唯一 Jigmo 没有的
        expect(shownZi('\u{33480}')).toBe('U+33480');     // 扩 J 之后（Unicode 18 起）
        expect(shownZi('')).toBe('U+E000');         // 私用区
        expect(canShow('之乎')).toBe(true);               // 不是单个码点：不管
        expect(cpLabel('之')).toBe('U+4E4B');
    });
});
