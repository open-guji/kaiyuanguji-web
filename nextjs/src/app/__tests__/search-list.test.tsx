/**
 * 搜索页 v3（overview#286）：结果是纵向列表（book-index-ui 0.22.0 的 resultVariant="list"），不再是 3 列卡片；
 * 每行是一个整行链接，行与行靠浅线分隔、无卡片底色。
 */
import { render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const captured: { props?: Record<string, unknown> } = {};
jest.mock('next/navigation', () => ({
    useRouter: () => ({ push: jest.fn() }),
    useSearchParams: () => new URLSearchParams('q=史記'),
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
    it('IndexBrowser 用 resultVariant="list"，并交给自己的行组件渲染', () => {
        render(<BookIndexPage />);
        expect(screen.getByTestId('browser')).toBeInTheDocument();
        expect(captured.props?.resultVariant).toBe('list');
        expect(typeof captured.props?.renderEntry).toBe('function');
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
