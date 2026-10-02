/**
 * 搜索页 v4（overview#298）：结果区是「左栏筛选＋表格／卡片」（book-index-ui 的 filtersEnabled），
 * 筛选状态在 URL（dy／cls／img／txt／col／loss），换检索词保留筛选。
 */
import { render, screen } from '@testing-library/react';

const captured: { props?: Record<string, any> } = {};
const push = jest.fn();
const replace = jest.fn();
const DEFAULT_QS = 'q=史記&dy=漢,唐&cls=史部&img=1&sort=era:desc';
let qs = DEFAULT_QS;
jest.mock('next/navigation', () => ({
    useRouter: () => ({ push, replace }),
    useSearchParams: () => new URLSearchParams(qs),
    usePathname: () => '/book-index',
}));
jest.mock('@/components/layout/LayoutWrapper', () => ({ children }: { children: React.ReactNode }) => <main>{children}</main>);
jest.mock('@/components/common/SourceContext', () => ({ useSource: () => ({ source: 'cos' }) }));
jest.mock('@/lib/transport', () => ({ getTransport: () => ({}), getSearchBaseUrl: async () => '' }));
jest.mock('@/lib/search/client', () => ({ getSearchClient: () => ({ init: async () => {} }) }));
jest.mock('@/lib/search/use-prefetch-search', () => ({ usePrefetchSearch: () => {} }));
jest.mock('@/lib/search/meili-storage', () => ({ isSearchDegraded: () => false, subscribeSearchDegraded: () => () => {} }));
jest.mock('@/components/book-index/BookDetailContent', () => () => null);
jest.mock('book-index-ui', () => {
    const actual = jest.requireActual('book-index-ui');
    return {
        ...actual,
        IndexBrowser: (props: Record<string, unknown>) => { captured.props = props; return <div data-testid="browser" />; },
        HomePage: () => null,
    };
});

import BookIndexPage from '../book-index/BookIndexClient';

describe('搜索页结果形态', () => {
    it('IndexBrowser 开 filtersEnabled，筛选从 URL 读出，不再走 resultVariant／renderEntry', () => {
        render(<BookIndexPage />);
        expect(screen.getByTestId('browser')).toBeInTheDocument();
        expect(captured.props?.filtersEnabled).toBe(true);
        expect(captured.props?.filters).toEqual({
            dynasty: ['漢', '唐'], classification: ['史部'], hasImage: true, hasText: false, hasCollated: false, loss: '', sort: 'era:desc',
        });
        expect(captured.props?.resultVariant).toBeUndefined();
        expect(captured.props?.renderEntry).toBeUndefined();
    });

    it('改筛选：写回 URL（保留 q，只动自己的键）；换检索词保留筛选；清空检索词回首页态', () => {
        render(<BookIndexPage />);
        push.mockClear();
        captured.props?.onFiltersChange({
            dynasty: ['清'], classification: [], hasImage: false, hasText: true, hasCollated: false, loss: 'lost', sort: 'title:asc',
        });
        const url = new URL(String(push.mock.calls[0][0]), 'http://x');
        expect(url.pathname).toBe('/book-index');
        expect(url.searchParams.get('q')).toBe('史記');
        expect(url.searchParams.get('dy')).toBe('清');
        expect(url.searchParams.get('txt')).toBe('1');
        expect(url.searchParams.get('loss')).toBe('lost');
        expect(url.searchParams.get('sort')).toBe('title:asc');
        expect(url.searchParams.has('cls')).toBe(false);
        expect(url.searchParams.has('img')).toBe(false);
        push.mockClear();
        captured.props?.onQueryChange('詩經');
        const u2 = new URL(String(push.mock.calls[0][0]), 'http://x');
        expect(u2.searchParams.get('q')).toBe('詩經');
        expect(u2.searchParams.get('dy')).toBe('漢,唐');
        push.mockClear();
        captured.props?.onQueryChange('  ');
        expect(push).toHaveBeenCalledWith('/book-index');
    });
});

describe('结果页签进地址（overview#359 P2-3）', () => {
    afterEach(() => { qs = DEFAULT_QS; push.mockClear(); replace.mockClear(); });

    it('?tab= 读出页签，单复数都认；没有或认不出就是「全部」', () => {
        for (const [tab, want] of [['work', 'work'], ['works', 'work'], ['entity', 'entity'], ['book', 'book'], ['x', 'all']] as const) {
            qs = `q=史記&tab=${tab}`;
            render(<BookIndexPage />);
            expect(captured.props?.resultTab).toBe(want);
        }
        qs = 'q=史記';
        render(<BookIndexPage />);
        expect(captured.props?.resultTab).toBe('all');
    });

    it('切页签：history.replaceState 改当前地址里的 tab（不走 router、不发 RSC），去掉 page；切回「全部」去掉 tab', () => {
        const spy = jest.spyOn(window.history, 'replaceState');
        window.history.replaceState(null, '', `/book-index?${DEFAULT_QS}&page=3`);
        spy.mockClear();
        render(<BookIndexPage />);
        captured.props?.onResultTabChange('collection');
        const u = new URL(String(spy.mock.calls[0][2]), 'http://x');
        expect(u.pathname).toBe('/book-index');
        expect(u.searchParams.get('tab')).toBe('collection');
        expect(u.searchParams.get('q')).toBe('史記');
        expect(u.searchParams.get('dy')).toBe('漢,唐');
        expect(u.searchParams.has('page')).toBe(false);
        expect(push).not.toHaveBeenCalled();
        expect(replace).not.toHaveBeenCalled();
        // 第二次基于「当前地址」改，不是渲染时的快照：连点两次不会互相覆盖
        captured.props?.onResultTabChange('all');
        expect(new URL(String(spy.mock.calls[1][2]), 'http://x').searchParams.has('tab')).toBe(false);
        spy.mockRestore();
    });

    it('换了筛选去掉 tab（组件回「全部」）；只换排序保留 tab；换检索词也不带 tab', () => {
        qs = `${DEFAULT_QS}&tab=work`;
        render(<BookIndexPage />);
        const base = { dynasty: ['漢', '唐'], classification: ['史部'], hasImage: true, hasText: false, hasCollated: false, loss: '' };
        captured.props?.onFiltersChange({ ...base, sort: 'title:asc' });
        expect(new URL(String(push.mock.calls[0][0]), 'http://x').searchParams.get('tab')).toBe('work');
        captured.props?.onFiltersChange({ ...base, dynasty: ['清'], sort: 'era:desc' });
        expect(new URL(String(push.mock.calls[1][0]), 'http://x').searchParams.has('tab')).toBe(false);
        captured.props?.onQueryChange('漢書');
        expect(new URL(String(push.mock.calls[2][0]), 'http://x').searchParams.has('tab')).toBe(false);
    });
});

describe('结果页码进地址', () => {
    afterEach(() => { qs = DEFAULT_QS; push.mockClear(); replace.mockClear(); });

    it('?page= 读出页码；没有、非正整数都按第 1 页', () => {
        for (const [page, want] of [['2', 2], ['10', 10], ['0', 1], ['-3', 1], ['x', 1], ['2.5', 1]] as const) {
            qs = `q=史記&tab=work&page=${page}`;
            render(<BookIndexPage />);
            expect(captured.props?.resultPage).toBe(want);
        }
        qs = 'q=史記';
        render(<BookIndexPage />);
        expect(captured.props?.resultPage).toBe(1);
    });

    it('翻页：replaceState 写 page，第 1 页去掉 page；其余参数不动', () => {
        const spy = jest.spyOn(window.history, 'replaceState');
        window.history.replaceState(null, '', `/book-index?${DEFAULT_QS}&tab=work`);
        spy.mockClear();
        render(<BookIndexPage />);
        captured.props?.onResultPageChange(2);
        const u = new URL(String(spy.mock.calls[0][2]), 'http://x');
        expect(u.searchParams.get('page')).toBe('2');
        expect(u.searchParams.get('tab')).toBe('work');
        expect(u.searchParams.get('q')).toBe('史記');
        window.history.replaceState(null, '', String(spy.mock.calls[0][2]));
        captured.props?.onResultPageChange(1);
        expect(new URL(String(spy.mock.calls.at(-1)![2]), 'http://x').searchParams.has('page')).toBe(false);
        expect(push).not.toHaveBeenCalled();
        spy.mockRestore();
    });

    it('换筛选、换排序都去掉 page；换检索词也不带 page', () => {
        qs = `${DEFAULT_QS}&tab=work&page=3`;
        render(<BookIndexPage />);
        const base = { dynasty: ['漢', '唐'], classification: ['史部'], hasImage: true, hasText: false, hasCollated: false, loss: '' };
        captured.props?.onFiltersChange({ ...base, sort: 'title:asc' });
        const u1 = new URL(String(push.mock.calls[0][0]), 'http://x');
        expect(u1.searchParams.has('page')).toBe(false);
        expect(u1.searchParams.get('tab')).toBe('work');
        captured.props?.onFiltersChange({ ...base, dynasty: ['清'], sort: 'era:desc' });
        expect(new URL(String(push.mock.calls[1][0]), 'http://x').searchParams.has('page')).toBe(false);
        captured.props?.onQueryChange('漢書');
        expect(new URL(String(push.mock.calls[2][0]), 'http://x').searchParams.has('page')).toBe(false);
    });
});
