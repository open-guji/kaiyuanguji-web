import { render, screen, within } from '@testing-library/react';
import Footer from '../Footer';

// 用户 9-30 反馈（overview#322）：左边只留四项，右边微信、QQ 两张二维码，各一行说明，QQ 加一行群号
describe('Footer（9-30 反馈）', () => {
    it('左边只有 关于我们、联系我们、反馈与纠错、项目源码', () => {
        render(<Footer />);
        const col = screen.getByRole('navigation', { name: '关于与联系' });
        const links = within(col).getAllByRole('link');
        expect(links.map((a) => [a.textContent, a.getAttribute('href')])).toEqual([
            ['关于我们', '/about'],
            ['联系我们', '/about#联系'],
            ['反馈与纠错', '/feedback'],
            ['项目源码', 'https://github.com/open-guji'],
        ]);
    });

    it('不外链腾讯问卷', () => {
        const { container } = render(<Footer />);
        expect(container.querySelector('a[href*="wj.qq.com"]')).toBeNull();
    });

    it('右边两张二维码：微信、QQ，各有说明，QQ 带群号；不出现占位文字', () => {
        const { container } = render(<Footer />);
        const figs = container.querySelectorAll('.og-footer-qrs figure');
        expect(figs).toHaveLength(2);
        expect(screen.getByRole('img', { name: /微信群.*二维码/ })).toHaveAttribute('src', '/images/wechat-group-qr.png');
        expect(screen.getByRole('img', { name: /QQ 群.*二维码/ })).toHaveAttribute('src', '/images/qq-group-qr.png');
        expect(figs[0].querySelector('figcaption')?.textContent).toBe('微信扫码进群');
        expect(figs[1].querySelector('figcaption')?.textContent).toBe('QQ 扫码进群群号 111362573');
        expect(container.textContent).not.toMatch(/〔|待定|待提供/);
    });
});
