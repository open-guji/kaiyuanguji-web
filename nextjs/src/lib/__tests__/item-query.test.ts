import { describe, it, expect } from '@jest/globals';
import { cleanItemSearch, ITEM_QUERY_WHITELIST } from '../item-query';

const clean = (q: string) => cleanItemSearch(new URLSearchParams(q));

describe('cleanItemSearch（条目页查询参数白名单，overview#280 S1）', () => {
    it('没有要去掉的 → null', () => {
        expect(clean('')).toBeNull();
        expect(clean('tab=lineage&page=2')).toBeNull();
    });
    it('全是多余的 → 空串', () => {
        expect(clean('utm_source=a&fbclid=b')).toBe('');
    });
    it('混合：白名单保持顺序与重复键，多余的去掉', () => {
        expect(clean('a=1&tab=x&b=2&tab=y&page=3')).toBe('?tab=x&tab=y&page=3');
    });
    it('值里的特殊字符按 URLSearchParams 规则重新编码', () => {
        expect(clean('x=1&collection=a%20b')).toBe('?collection=a+b');
    });
    it('白名单就是详情组件用的这些', () => {
        expect([...ITEM_QUERY_WHITELIST].sort()).toEqual(['collection', 'juan', 'mode', 'no_redirect', 'page', 'redirected_from', 'tab']);
    });
});
