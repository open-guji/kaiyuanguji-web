import { render, screen, within } from '@testing-library/react';

jest.mock('next/navigation', () => ({
    usePathname: () => '/contact',
    useRouter: () => ({ push: jest.fn() }),
}));
jest.mock('@/components/common/FeedbackWidget', () => () => null);

import ContactPage from '../page';

describe('联系页（N6）', () => {
    it('主操作是「去反馈」，指向 /feedback', () => {
        render(<ContactPage />);
        expect(screen.getByRole('heading', { level: 1, name: '联系我们' })).toBeInTheDocument();
        expect(screen.getByRole('link', { name: '去反馈' })).toHaveAttribute('href', '/feedback');
    });

    it('GitHub Issues 分数据和网站两处', () => {
        render(<ContactPage />);
        expect(screen.getByRole('link', { name: 'book-index Issues' })).toHaveAttribute(
            'href',
            'https://github.com/open-guji/book-index/issues',
        );
        expect(screen.getByRole('link', { name: 'kaiyuanguji-web Issues' })).toHaveAttribute(
            'href',
            'https://github.com/open-guji/kaiyuanguji-web/issues',
        );
    });

    it('没给的联系方式不渲染：无邮箱、无二维码、无占位', () => {
        const { container } = render(<ContactPage />);
        const main = screen.getByRole('main');
        expect(within(main).queryByText(/邮箱|公众号|交流群/)).toBeNull();
        expect(container.querySelector('a[href^="mailto:"]')).toBeNull();
        expect(container.textContent).not.toMatch(/〔|待定|待提供|二维码/);
    });
});
