import { describe, it, expect } from '@jest/globals';
import { cleanItemSearch, detailUrl, ITEM_QUERY_WHITELIST } from '../item-query';

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

describe('detailUrl（overview#577：详情页内改状态不跳出 /item/<id>）', () => {
    it('在 /item/<id> 下：留在 /item/<id>，id 不进查询串，其余参数保留', () => {
        const p = new URLSearchParams({ tab: 'fulltext', juan: '3', id: 'zzz' });
        expect(detailUrl('/item/98y5qfl7nl', '98y5qfl7nl', p)).toBe('/item/98y5qfl7nl?tab=fulltext&juan=3');
    });
    it('没有参数时不留尾巴 ?', () => {
        expect(detailUrl('/item/abc', 'abc', new URLSearchParams())).toBe('/item/abc');
    });
    it('升格重定向换 id：路径换成新 id', () => {
        const p = new URLSearchParams({ redirected_from: 'old' });
        expect(detailUrl('/item/old', 'new', p)).toBe('/item/new?redirected_from=old');
    });
    it('在 /book-index（草稿兜底页）：保持旧写法，id 进查询串', () => {
        expect(detailUrl('/book-index', 'd1', new URLSearchParams({ tab: 'basic' }))).toBe('/book-index?tab=basic&id=d1');
    });
    it('pathname 取不到（null）：按旧写法', () => {
        expect(detailUrl(null, 'd1', new URLSearchParams())).toBe('/book-index?id=d1');
    });
});
