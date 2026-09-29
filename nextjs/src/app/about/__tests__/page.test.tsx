import { render, screen, within } from '@testing-library/react';

jest.mock('next/navigation', () => ({
    usePathname: () => '/about',
    useRouter: () => ({ push: jest.fn() }),
}));

import AboutPage from '../page';

describe('关于页（N6）', () => {
    it('目录与各节一一对应，没有团队一节', () => {
        render(<AboutPage />);
        const toc = screen.getByRole('navigation', { name: '本页目录' });
        const hrefs = within(toc).getAllByRole('link').map((a) => a.getAttribute('href'));
        expect(hrefs).toEqual(['#intro', '#license', '#thanks', '#repos', '#contact']);
        for (const h of hrefs) {
            expect(document.getElementById(h!.slice(1))).not.toBeNull();
        }
        expect(screen.queryByRole('heading', { name: '团队' })).toBeNull();
    });

    it('致谢只列维基文库和 Kanripo', () => {
        render(<AboutPage />);
        const thanks = document.getElementById('thanks')!;
        expect(within(thanks).getAllByRole('link').map((a) => a.textContent)).toEqual([
            '维基文库',
            'Kanripo（漢籍リポジトリ）',
        ]);
    });

    it('写明 CC0 与第三方全文许可，链到联系页，不出现占位', () => {
        const { container } = render(<AboutPage />);
        expect(screen.getByText(/CC0 1\.0 Universal/)).toBeInTheDocument();
        expect(screen.getByText(/CC BY-SA 4\.0，Kanripo/)).toBeInTheDocument();
        expect(within(document.getElementById('contact')!).getByRole('link', { name: '联系我们' })).toHaveAttribute(
            'href',
            '/contact',
        );
        expect(container.textContent).not.toMatch(/〔|待定|待提供/);
    });
});
