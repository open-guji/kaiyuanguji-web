/**
 * 汉字能不能在本站显示：能显示就照常显示字，显示不出来（会变成方框「豆腐块」）的就改显示码位 U+XXXXX。
 *
 * 判据是**字体栈声明覆盖的区段**，不是在浏览器里探测（没有可靠的 API）：
 *   - 基本区 U+4E00–9FFF 由系统字体兜底（末尾 U+9FA6–9FFF 另有网络字体）；
 *   - 其余照 `app/zi-fonts.css` 各块的 `unicode-range`（Jigmo 2025.9.12 实有字形的码位，GUJI-721），表在 `zi-coverage.generated.ts`，
 *     两者都由 `scripts/zi-fonts.mjs gen` 生成，`__tests__/zi-display.test.ts` 对账。
 *     Jigmo 覆盖到 Unicode 17（扩 J），只缺扩 D 的 U+2B81E；私用区、Unicode 18 以后新增的字显示码位。
 * 长远的字体方案见仓库 `docs/扩展区与未收字显示-设计.md`。
 */
import { ZI_FONT_RANGES } from './zi-coverage.generated';

const BASIC: readonly [number, number] = [0x4e00, 0x9fff];

/** 本站字体能显示的汉字码位区段（闭区间），按起点排好、相邻的已合并 */
export const SHOWABLE_RANGES: ReadonlyArray<readonly [number, number]> = (() => {
    const out: [number, number][] = [];
    for (const r of [...ZI_FONT_RANGES, BASIC].sort((x, y) => x[0] - y[0])) {
        const last = out[out.length - 1];
        if (last && r[0] <= last[1] + 1) last[1] = Math.max(last[1], r[1]);
        else out.push([r[0], r[1]]);
    }
    return out;
})();

/** 汉字（含各扩展区、兼容区）与私用区的码位段：落在这里、又不在 SHOWABLE_RANGES 里的，就是显示不出来的 */
const HAN_OR_PUA: ReadonlyArray<readonly [number, number]> = [
    [0x3400, 0x4dbf], [0x4e00, 0x9fff], [0xe000, 0xf8ff], [0xf900, 0xfaff],
    [0x20000, 0x2ffff], [0x30000, 0x3ffff], [0xf0000, 0x10ffff],   // 第 2、3 平面整个算汉字：以后新增的扩展区先显示码位
];

const inRanges = (o: number, rs: ReadonlyArray<readonly [number, number]>) => rs.some(([a, b]) => o >= a && o <= b);

/** 这个字（一个码点）本站能不能显示。非汉字（标点、拉丁字母、□ 等）一律算能显示 */
export function canShow(c: string): boolean {
    const o = c.codePointAt(0);
    if (o === undefined || [...c].length !== 1) return true;
    return !inRanges(o, HAN_OR_PUA) || inRanges(o, SHOWABLE_RANGES);
}

/** 码位标签：「U+2B735」 */
export function cpLabel(c: string): string {
    const o = c.codePointAt(0) ?? 0;
    return `U+${o.toString(16).toUpperCase().padStart(4, '0')}`;
}

/** 显示用的字：能显示就是字本身，否则是码位标签 */
export function shownZi(c: string): string {
    return canShow(c) ? c : cpLabel(c);
}
