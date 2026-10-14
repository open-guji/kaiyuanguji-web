import { cpToUtf16, utf16ToCp, cpRangesToUtf16, mapMdRangesToRendered } from '../fulltext/fulltext-offsets';

const B = '𠀀'; // U+20000，扩展 B 区：UTF-16 占 2

describe('fulltext-offsets', () => {
    it('① 扩展 B 区字：码点↔UTF-16 往返相等', () => {
        const s = `甲${B}乙${B}丙`;
        expect(s.length).toBe(7);
        for (let cp = 0; cp <= 5; cp++) {
            const u = cpToUtf16(s, cp);
            expect(u).toBeGreaterThanOrEqual(0);
            expect(utf16ToCp(s, u)).toBe(cp);
        }
        expect(cpToUtf16(s, 3)).toBe(4); // 甲(1)+B(2)+乙(1)
        // 命中"乙"：码点 [2,3) → UTF-16 [3,4)，slice 得到"乙"
        const [r] = cpRangesToUtf16(s, [[2, 3]]);
        expect(s.slice(r[0], r[1])).toBe('乙');
        // 命中"𠀀"本身
        const [r2] = cpRangesToUtf16(s, [[1, 2]]);
        expect(s.slice(r2[0], r2[1])).toBe(B);
    });

    it('① 反例：把码点偏移当 UTF-16 用会错位（守门：此处必须不等）', () => {
        const s = `甲${B}乙`;
        expect(s.slice(2, 3)).not.toBe('乙');
    });

    it('④ 空区间／越界／非法返回空而不抛', () => {
        const s = '甲乙丙';
        expect(cpRangesToUtf16(s, [[1, 1]])).toEqual([]);
        expect(cpRangesToUtf16(s, [[2, 1]])).toEqual([]);
        expect(cpRangesToUtf16(s, [[0, 9]])).toEqual([]);
        expect(cpRangesToUtf16(s, [[-1, 2]])).toEqual([]);
        expect(cpRangesToUtf16(s, [[0.5, 2]])).toEqual([]);
        expect(cpToUtf16(s, 4)).toBe(-1);
        expect(utf16ToCp(s, 9)).toBe(-1);
        expect(cpToUtf16('', 0)).toBe(0);
        expect(() => cpRangesToUtf16(s, [null as never, [1] as never])).not.toThrow();
    });

    it('② 区间跨夹注 <…>：渲染区间不含标记', () => {
        const md = '子曰<學而>時習'; // 码点: 子0 曰1 <2 學3 而4 >5 時6 習7
        expect(mapMdRangesToRendered(md, [[1, 7]])).toEqual([[1, 5]]); // 曰學而時 → 渲染 子曰學而時習 中 [1,5)
        expect(Array.from('子曰學而時習').slice(1, 5).join('')).toBe('曰學而時');
    });

    it('③ 夹注在区间起／止点：高亮不含标记字符', () => {
        const md = '子曰<學而>時習';
        // 起点落在 `<`：[2,5)=「< 學 而」→ 渲染「學而」[2,4)
        expect(mapMdRangesToRendered(md, [[2, 5]])).toEqual([[2, 4]]);
        // 止点落在 `>` 之后：[3,6)=「學 而 >」→ 渲染「學而」[2,4)
        expect(mapMdRangesToRendered(md, [[3, 6]])).toEqual([[2, 4]]);
        // 区间只含标记：丢弃
        expect(mapMdRangesToRendered(md, [[2, 3]])).toEqual([]);
    });

    it('⑤ 未闭合 < 按字面', () => {
        const md = '甲<乙丙';
        expect(mapMdRangesToRendered(md, [[0, 4]])).toEqual([[0, 4]]);
    });

    it('扩展 B 区字与夹注混合', () => {
        const md = `${B}<乙>丙`; // 𠀀0 <1 乙2 >3 丙4
        expect(mapMdRangesToRendered(md, [[0, 5]])).toEqual([[0, 3]]);
    });
});
