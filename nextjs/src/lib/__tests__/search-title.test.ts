import { searchPageTitle } from '../search-title';

describe('searchPageTitle', () => {
    it('带检索词：「朱熹 - 搜索」（站名由根布局补）', () => {
        expect(searchPageTitle('朱熹')).toBe('朱熹 - 搜索');
        expect(searchPageTitle('  程甲本 ')).toBe('程甲本 - 搜索');
        expect(searchPageTitle(['史記', '别的'])).toBe('史記 - 搜索');
    });
    it('没有检索词返回 null（用站名默认 title）', () => {
        for (const q of [undefined, null, '', '   ', []]) expect(searchPageTitle(q as never)).toBeNull();
    });
});
