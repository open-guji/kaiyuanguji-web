import { render, screen, within } from '@testing-library/react';
import Footer from '../Footer';

// N6（overview#259）：页脚「关于与联系」栏
describe('Footer · 关于与联系（N6）', () => {
    it('关于我们、联系我们、反馈与纠错都指向站内页，另有项目源码', () => {
        render(<Footer />);
        const col = screen.getByRole('navigation', { name: '关于与联系' });
        const links = within(col).getAllByRole('link');
        expect(links.map((a) => [a.textContent, a.getAttribute('href')])).toEqual([
            ['关于我们', '/about'],
            ['联系我们', '/contact'],
            ['反馈与纠错', '/feedback'],
            ['项目源码', 'https://github.com/open-guji'],
        ]);
    });

    it('不再外链腾讯问卷，反馈不在站内栏重复', () => {
        const { container } = render(<Footer />);
        expect(container.querySelector('a[href*="wj.qq.com"]')).toBeNull();
        const site = screen.getByRole('navigation', { name: '站内链接' });
        expect(within(site).queryByRole('link', { name: /反馈/ })).toBeNull();
        expect(within(site).getByRole('link', { name: '古籍总目' })).toHaveAttribute('href', '/catalog');
    });

    it('不出现占位文字和二维码', () => {
        const { container } = render(<Footer />);
        expect(container.textContent).not.toMatch(/〔|待定|待提供/);
        expect(container.innerHTML).not.toMatch(/二维码|qrcode|qr-code/i);
    });
});
