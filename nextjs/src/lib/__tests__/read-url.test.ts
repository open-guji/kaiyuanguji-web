import { buildReadUrl } from '../read-url';

describe('buildReadUrl（阅读页地址约定）', () => {
    it('整理本只带 kind', () => {
        expect(buildReadUrl('d59f20aowb9c', { kind: 'collated' })).toBe('/item/d59f20aowb9c/read?kind=collated');
    });

    it('Work 全文带 key', () => {
        expect(buildReadUrl('d59f20aowb9c', { kind: 'fulltext', key: 'wikisource' }))
            .toBe('/item/d59f20aowb9c/read?kind=fulltext&key=wikisource');
    });

    it('按 kind、key、juan 的顺序拼参数，空值不出现', () => {
        expect(buildReadUrl('988g3f0wsu', { kind: 'fulltext', key: null, juan: '001' }))
            .toBe('/item/988g3f0wsu/read?kind=fulltext&juan=001');
        expect(buildReadUrl('x', { kind: 'fulltext', key: 'a b', juan: '卷一' }))
            .toBe('/item/x/read?kind=fulltext&key=a+b&juan=%E5%8D%B7%E4%B8%80');
    });
});
