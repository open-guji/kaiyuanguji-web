/**
 * GUJI-163 F6 步 4：阅读页 ?ft=／?ftq= 解析与按文本定位。
 */
import { parseFtParams, findQueryNode } from '../fulltext/fulltext-locate';

describe('parseFtParams', () => {
    it('正常：ft=<章>:<起>-<止> ＋ ftq', () => {
        expect(parseFtParams('?ft=001%3A3-8&ftq=%E5%AD%B8%E8%80%8C')).toEqual({ chapter: '001', start: 3, end: 8, q: '學而' });
    });
    it('无 ft：返回 null（阅读页行为不变）', () => {
        expect(parseFtParams('')).toBeNull();
        expect(parseFtParams('?foo=1')).toBeNull();
    });
    it.each(['abc', '001:3', '001:8-3', '001:-1-2', ':1-2', '001:1-2-3', '1234567:1-2', '001:99999999999-2'])('非法 ft=%s 返回 null', (v) => {
        expect(parseFtParams(`?ft=${encodeURIComponent(v)}`)).toBeNull();
    });
    it('ftq 过长截断、控制字符去掉；缺省为空串', () => {
        expect(parseFtParams('?ft=001:1-2')?.q).toBe('');
        const long = 'x'.repeat(500);
        expect(parseFtParams(`?ft=001:1-2&ftq=${long}`)?.q.length).toBe(100);
        expect(parseFtParams(`?ft=001:1-2&ftq=${encodeURIComponent('a\u0000b\nc')}`)?.q).toBe('abc');
    });
    it('ftq 原样保留尖括号（只当文本，由调用方用文本节点显示）', () => {
        expect(parseFtParams(`?ft=001:1-2&ftq=${encodeURIComponent('<img src=x onerror=alert(1)>')}`)?.q).toBe('<img src=x onerror=alert(1)>');
    });
});

describe('findQueryNode', () => {
    it('找到含查询词的元素（跨文本节点也行）', () => {
        document.body.innerHTML = '<div id="h"><p>前文</p><p>子曰：學<span>而時</span>習之。</p></div>';
        const el = findQueryNode(document.getElementById('h')!, '學而時習');
        expect(el?.tagName).toBe('P');
        expect(el?.textContent).toContain('子曰');
    });
    it('找不到或空查询返回 null', () => {
        document.body.innerHTML = '<div id="h"><p>無關</p></div>';
        expect(findQueryNode(document.getElementById('h')!, '學而')).toBeNull();
        expect(findQueryNode(document.getElementById('h')!, '')).toBeNull();
    });
});
