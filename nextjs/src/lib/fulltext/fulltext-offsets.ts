/**
 * 全文搜索偏移换算（GUJI-163 / F6 步 1）：纯函数，无 DOM。
 *
 * F1 契约的 `matches` 是章内 **Unicode 码点**偏移（不是 UTF-16 code unit）：`𠀀` 等扩展 B 区字
 * 在 JS 字符串里占 2 个 code unit、在码点偏移里占 1。直接拿码点偏移去 `slice` 会错位。
 *
 * 区间一律是半开区间 `[start, end)`；越界、起 ≥ 止、非整数的区间被丢弃（返回空，不抛）。
 */

export type Range = readonly [number, number];

const isInt = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n);

/** 码点偏移 → UTF-16 偏移；越界返回 -1。允许 `cpIdx === 码点总数`（串尾）。 */
export function cpToUtf16(s: string, cpIdx: number): number {
    if (!isInt(cpIdx) || cpIdx < 0) return -1;
    let cp = 0;
    let i = 0;
    while (i < s.length) {
        if (cp === cpIdx) return i;
        const c = s.charCodeAt(i);
        i += c >= 0xd800 && c <= 0xdbff && i + 1 < s.length ? 2 : 1;
        cp++;
    }
    return cp === cpIdx ? s.length : -1;
}

/** UTF-16 偏移 → 码点偏移；越界返回 -1；落在代理对中间按该字起点计。 */
export function utf16ToCp(s: string, idx: number): number {
    if (!isInt(idx) || idx < 0 || idx > s.length) return -1;
    let cp = 0;
    let i = 0;
    while (i < s.length && i < idx) {
        const c = s.charCodeAt(i);
        i += c >= 0xd800 && c <= 0xdbff && i + 1 < s.length ? 2 : 1;
        if (i <= idx) cp++;
    }
    return cp;
}

/** 一组码点区间 → UTF-16 区间；非法区间丢弃，保持原顺序。 */
export function cpRangesToUtf16(s: string, ranges: readonly Range[]): Range[] {
    const out: Range[] = [];
    for (const r of ranges) {
        if (!Array.isArray(r) || r.length !== 2) continue;
        const [a, b] = r;
        if (!isInt(a) || !isInt(b) || a >= b) continue;
        const ua = cpToUtf16(s, a);
        const ub = cpToUtf16(s, b);
        if (ua < 0 || ub < 0) continue;
        out.push([ua, ub]);
    }
    return out;
}

/**
 * 整理本 md 里夹注写作 `<…>`；渲染文本去掉 `<` `>` 两个标记字符本身。
 * 把 md 的**码点**区间换算成渲染文本的**码点**区间：
 *  - 标记字符不占渲染位置；区间端点落在标记上时，起点右移、止点左移（高亮不含标记）。
 *  - 未闭合的 `<`（后面没有 `>`）按字面字符，保留。
 *  - 换算后为空的区间丢弃。
 * TODO(GUJI-163 步 6)：夹注识别应复用 bim `scanJiazhu`（spec §1）；现版本只处理最简 `<…>`，待其导出后替换。
 */
export function mapMdRangesToRendered(md: string, ranges: readonly Range[]): Range[] {
    const cps = Array.from(md);
    // 标记位：closed 的 `<` 与其配对的 `>`
    const marker = new Array<boolean>(cps.length).fill(false);
    let open = -1;
    for (let i = 0; i < cps.length; i++) {
        if (cps[i] === '<' && open < 0) open = i;
        else if (cps[i] === '>' && open >= 0) { marker[open] = true; marker[i] = true; open = -1; }
    }
    // before[i] = md 码点 i 之前（不含）的渲染码点数
    const before = new Array<number>(cps.length + 1).fill(0);
    for (let i = 0; i < cps.length; i++) before[i + 1] = before[i] + (marker[i] ? 0 : 1);
    const out: Range[] = [];
    for (const r of ranges) {
        if (!Array.isArray(r) || r.length !== 2) continue;
        const [a, b] = r;
        if (!isInt(a) || !isInt(b) || a < 0 || b > cps.length || a >= b) continue;
        const ra = before[a];
        const rb = before[b];
        if (ra < rb) out.push([ra, rb]);
    }
    return out;
}
