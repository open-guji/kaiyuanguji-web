import { render, screen, within } from '@testing-library/react';

jest.mock('next/navigation', () => ({
    usePathname: () => '/contact',
    useRouter: () => ({ push: jest.fn() }),
}));

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

    it('邮箱与 QQ 群', () => {
        render(<ContactPage />);
        expect(screen.getByRole('link', { name: 'sheldonli.dev@gmail.com' })).toHaveAttribute(
            'href',
            'mailto:sheldonli.dev@gmail.com',
        );
        expect(screen.getByText(/QQ 群：111362573/)).toBeInTheDocument();
    });

    it('微信群二维码在正文里；无公众号、无占位', () => {
        const { container } = render(<ContactPage />);
        const main = screen.getByRole('main');
        expect(within(main).getByRole('img', { name: /微信群.*二维码/ })).toHaveAttribute('src', '/images/wechat-group-qr.png');
        expect(within(main).getByText(/微信群：开源古籍交流群/)).toBeInTheDocument();
        expect(within(main).queryByText(/公众号/)).toBeNull();
        expect(container.textContent).not.toMatch(/〔|待定|待提供/);
    });
});
