/**
 * 搜索页 v4（overview#298）：结果区是「左栏筛选＋表格／卡片」（book-index-ui 的 filtersEnabled），
 * 筛选状态在 URL（dy／cls／img／txt／col／loss），换检索词保留筛选。
 * （SearchResultCard 的行样式是 v3 的遗留，组件保留但搜索页不再用。）
 */
import { render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const captured: { props?: Record<string, any> } = {};
const push = jest.fn();
jest.mock('next/navigation', () => ({
    useRouter: () => ({ push }),
    useSearchParams: () => new URLSearchParams('q=史記&dy=漢,唐&cls=史部&img=1'),
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
            dynasty: ['漢', '唐'], classification: ['史部'], hasImage: true, hasText: false, hasCollated: false, loss: '',
        });
        expect(captured.props?.resultVariant).toBeUndefined();
        expect(captured.props?.renderEntry).toBeUndefined();
    });

    it('改筛选：写回 URL（保留 q，只动自己的键）；换检索词保留筛选；清空检索词回首页态', () => {
        render(<BookIndexPage />);
        push.mockClear();
        captured.props?.onFiltersChange({
            dynasty: ['清'], classification: [], hasImage: false, hasText: true, hasCollated: false, loss: 'lost',
        });
        const url = new URL(String(push.mock.calls[0][0]), 'http://x');
        expect(url.pathname).toBe('/book-index');
        expect(url.searchParams.get('q')).toBe('史記');
        expect(url.searchParams.get('dy')).toBe('清');
        expect(url.searchParams.get('txt')).toBe('1');
        expect(url.searchParams.get('loss')).toBe('lost');
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

    it('结果行样式：无卡片底色与圆角，行间浅线，悬停换底（不再抬起投影）', () => {
        const css = readFileSync(join(process.cwd(), 'src/components/book-index/SearchResultCard.module.css'), 'utf8');
        const card = css.match(/\.card\s*\{([^}]*)\}/)?.[1] ?? '';
        expect(card).toContain('border-bottom: 1px solid var(--color-tint-2)');
        expect(card).toContain('background: transparent');
        expect(card).not.toContain('box-shadow');
        const hover = css.match(/\.card:hover\s*\{([^}]*)\}/)?.[1] ?? '';
        expect(hover).toContain('background: var(--color-tint)');
        expect(hover).not.toContain('--shadow-lift');
    });
});
