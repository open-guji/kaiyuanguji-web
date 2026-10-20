/**
 * 汉字能不能在本站显示：能显示就照常显示字，显示不出来（会变成方框「豆腐块」）的就改显示码位 U+XXXXX。
 *
 * 判据是**字体栈声明覆盖的区段**，不是在浏览器里探测（没有可靠的 API）：
 *   - 基本区 U+4E00–9FFF 由系统字体兜底；
 *   - 其余照 `app/globals.css` 里花园明朝（HanaMinA／HanaMinB）的 `unicode-range`。
 *     注意花园明朝是 2017 年的字库：扩 A 只到 U+4DB5，扩 B–F 各区也缺 Unicode 13 以后补进的尾巴；
 *     扩 G、H、I、J 完全没有。
 * 改了 globals.css 的字体区段就同步改 `SHOWABLE_RANGES`（`__tests__/zi-display.test.ts` 会对账）。
 * 长远的字体方案见仓库 `docs/扩展区与未收字显示-需求.md`。
 */

/** 本站字体能显示的汉字码位区段（闭区间），按起点排好 */
export const SHOWABLE_RANGES: ReadonlyArray<readonly [number, number]> = [
    [0x3400, 0x4db5],     // 扩 A（HanaMinA）
    [0x4e00, 0x9fff],     // 基本区（系统字体）
    [0xf900, 0xfa6d],     // 兼容表意文字（HanaMinA）
    [0xfa70, 0xfad9],
    [0x20000, 0x2a6d6],   // 扩 B（HanaMinB）
    [0x2a700, 0x2b734],   // 扩 C
    [0x2b740, 0x2b81d],   // 扩 D
    [0x2b820, 0x2cea1],   // 扩 E
    [0x2ceb0, 0x2ebe0],   // 扩 F
    [0x2f800, 0x2fa1d],   // 兼容表意文字补充（HanaMinA）
];

/** 汉字（含各扩展区、兼容区）与私用区的码位段：落在这里、又不在 SHOWABLE_RANGES 里的，就是显示不出来的 */
const HAN_OR_PUA: ReadonlyArray<readonly [number, number]> = [
    [0x3400, 0x4dbf], [0x4e00, 0x9fff], [0xe000, 0xf8ff], [0xf900, 0xfaff],
    [0x20000, 0x2fa1f], [0x30000, 0x3347f], [0xf0000, 0x10ffff],
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
