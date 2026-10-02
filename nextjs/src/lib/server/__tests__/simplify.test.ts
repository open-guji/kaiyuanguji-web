/**
 * 服务端繁→简（title／meta）：异体字先归一再走 t2cn（overview#350），与组件库 LocaleProvider 同一张表。
 */
import VARIANT_CHARS from 'book-index-ui/variant-chars.json';
import { normalizeVariants, simplifyMetadata, toSimplified } from '../simplify';

describe('normalizeVariants／toSimplified', () => {
    it('㫖、縂、寳 转成 旨、总、宝（脂评凡例里用户报的字）', () => {
        expect(toSimplified('其㫖縂在風月寳鑑')).toBe('其旨总在风月宝鉴');
    });

    it('归一只换表里的异体字，按码位处理扩展区字；没有异体字时原样', () => {
        expect(normalizeVariants('風月寳鑑')).toBe('風月寶鑑');
        const astral = Object.keys(VARIANT_CHARS).find((c) => c.codePointAt(0)! > 0xffff)!;
        expect(normalizeVariants(`甲${astral}乙`)).toBe(`甲${(VARIANT_CHARS as Record<string, string>)[astral]}乙`);
        const plain = '史記';
        expect(normalizeVariants(plain)).toBe(plain);
    });

    it('与组件库共用同一张表（不另存副本）', () => {
        expect(Object.keys(VARIANT_CHARS).length).toBeGreaterThan(500);
        expect((VARIANT_CHARS as Record<string, string>)['㫖']).toBe('旨');
    });
});

describe('simplifyMetadata', () => {
    it('title、description、og 里的异体字同样转简体', () => {
        const m = simplifyMetadata({ title: '風月寳鑑', description: '凡例㫖要', openGraph: { title: '縂評' } });
        expect(m.title).toBe('风月宝鉴');
        expect(m.description).toBe('凡例旨要');
        expect((m.openGraph as { title: string }).title).toBe('总评');
    });
});
