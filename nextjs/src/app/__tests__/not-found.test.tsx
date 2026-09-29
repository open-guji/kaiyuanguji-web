import { render, screen } from '@testing-library/react';

jest.mock('@/components/layout/LayoutWrapper', () => ({ children }: { children: React.ReactNode }) => <div data-testid="shell">{children}</div>);

import NotFound, { metadata } from '../not-found';

describe('站点 404 页（overview#267 P2-4）', () => {
    it('站点外壳里的中文文案，一个 h1', () => {
        render(<NotFound />);
        expect(screen.getByTestId('shell')).toBeInTheDocument();
        expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
        expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('找不到这个页面');
    });

    it('三个入口：回首页（唯一主按钮）、去古籍总目、去搜索', () => {
        render(<NotFound />);
        const links = screen.getAllByRole('link').map((a) => [a.textContent, a.getAttribute('href')]);
        expect(links).toEqual([['回首页', '/'], ['去古籍总目', '/catalog'], ['去搜索', '/book-index']]);
        expect(screen.queryAllByRole('button')).toHaveLength(0);
    });

    it('title 是中文、noindex', () => {
        expect(metadata.title).toBe('找不到这个页面');
        expect(metadata.robots).toEqual({ index: false, follow: false });
    });
});
