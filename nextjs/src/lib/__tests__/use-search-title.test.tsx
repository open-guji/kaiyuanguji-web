import { renderHook } from '@testing-library/react';
import { searchTitle, useSearchTitle } from '../use-search-title';

describe('searchTitle', () => {
    it('带检索词：「朱熹 - 搜索 - 开源古籍」', () => {
        expect(searchTitle('朱熹')).toBe('朱熹 - 搜索 - 开源古籍');
        expect(searchTitle('  程甲本 ')).toBe('程甲本 - 搜索 - 开源古籍');
    });
    it('没有检索词就是站名', () => {
        for (const q of [undefined, null, '', '   ']) expect(searchTitle(q)).toBe('开源古籍');
    });
});

describe('useSearchTitle', () => {
    beforeEach(() => { document.title = '开源古籍'; });

    it('title 跟着检索词走，卸载时还原', () => {
        const { rerender, unmount } = renderHook(({ q }) => useSearchTitle(q), { initialProps: { q: '朱熹' as string | null } });
        expect(document.title).toBe('朱熹 - 搜索 - 开源古籍');
        rerender({ q: '史記' });
        expect(document.title).toBe('史記 - 搜索 - 开源古籍');
        rerender({ q: null });
        expect(document.title).toBe('开源古籍');
        unmount();
        expect(document.title).toBe('开源古籍');
    });

    it('enabled=false（进了条目详情）时不动 title', () => {
        document.title = '史記 - 开源古籍';
        renderHook(() => useSearchTitle('朱熹', false));
        expect(document.title).toBe('史記 - 开源古籍');
    });
});
