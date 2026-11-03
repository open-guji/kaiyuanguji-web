import { render, screen, within } from '@testing-library/react';
import Footer from '../Footer';

// 用户 9-30 反馈（overview#322）：左边只留四项，11-03 起右边只留 QQ 群号文字
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

    it('右边只有 QQ 群号文字，没有二维码；不出现占位文字', () => {
        const { container } = render(<Footer />);
        expect(container.querySelector('.og-footer-group')?.textContent).toBe('QQ 群 111362573');
        expect(container.querySelector('img')).toBeNull();
        expect(container.textContent).not.toMatch(/〔|待定|待提供/);
    });
});
