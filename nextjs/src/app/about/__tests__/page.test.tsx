import { render, screen, within } from '@testing-library/react';

jest.mock('next/navigation', () => ({
    usePathname: () => '/about',
    useRouter: () => ({ push: jest.fn() }),
}));

import AboutPage from '../page';

describe('关于页（N6）', () => {
    it('底色用暖纸色令牌的 og-paper 类', () => {
        const { container } = render(<AboutPage />);
        expect(container.querySelector('.og-paper')).not.toBeNull();
    });

    it('目录与各节一一对应，没有团队一节', () => {
        render(<AboutPage />);
        const toc = screen.getByRole('navigation', { name: '本页目录' });
        const hrefs = within(toc).getAllByRole('link').map((a) => a.getAttribute('href'));
        // 「项目介绍」「开源仓库」两节已删（用户意见，overview#267）
        expect(hrefs).toEqual(['#license', '#thanks', '#联系']);
        expect(document.getElementById('intro')).toBeNull();
        expect(document.getElementById('repos')).toBeNull();
        expect(screen.queryByRole('heading', { name: '项目介绍' })).toBeNull();
        expect(screen.queryByRole('heading', { name: '开源仓库' })).toBeNull();
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

    it('数据来源与授权：book-index 与 book-text 都是 CC0，第三方全文沿用来源许可，代码 Apache-2.0；不提 book-index-draft（9-30 反馈）', () => {
        const { container } = render(<AboutPage />);
        const lic = document.getElementById('license')!;
        const rows = within(lic).getAllByRole('row').map((r) => r.textContent ?? '');
        expect(rows.find((r) => r.includes('book-index）'))).toMatch(/CC0 1\.0 Universal/);
        expect(rows.find((r) => r.includes('book-text'))).toMatch(/CC0 1\.0 Universal/);
        expect(rows.find((r) => r.includes('转录自第三方'))).toMatch(/CC BY-SA 4\.0，Kanripo 为 CC BY-SA/);
        expect(rows.find((r) => r.startsWith('代码'))).toMatch(/Apache License 2\.0/);
        expect(container.textContent).not.toContain('book-index-draft');
        expect(container.textContent).not.toMatch(/未声明许可/);
        expect(container.textContent).not.toContain('不是最终事实来源');
        expect(container.textContent).not.toMatch(/〔|待定|待提供/);
    });

    it('联系页内容展开在 #联系：去反馈、GitHub Issues、邮箱、微信与 QQ 两张二维码（QQ 带群号）', () => {
        render(<AboutPage />);
        const sec = within(document.getElementById('联系')!);
        expect(sec.getByRole('heading', { level: 2, name: '联系我们' })).toBeInTheDocument();
        expect(sec.getByRole('link', { name: '去反馈' })).toHaveAttribute('href', '/feedback');
        expect(sec.getByRole('link', { name: 'book-index Issues' })).toHaveAttribute('href', 'https://github.com/open-guji/book-index/issues');
        expect(sec.getByRole('link', { name: 'kaiyuanguji-web Issues' })).toHaveAttribute('href', 'https://github.com/open-guji/kaiyuanguji-web/issues');
        expect(sec.getByRole('link', { name: 'sheldonli.dev@gmail.com' })).toHaveAttribute('href', 'mailto:sheldonli.dev@gmail.com');
        expect(sec.getByRole('img', { name: /微信群.*二维码/ })).toHaveAttribute('src', '/images/wechat-group-qr.png');
        expect(sec.getByRole('img', { name: /QQ 群.*二维码/ })).toHaveAttribute('src', '/images/qq-group-qr.png');
        expect(sec.getByText(/QQ 群：111362573/)).toBeInTheDocument();
        expect(sec.queryByText(/公众号/)).toBeNull();
        expect(sec.queryByRole('link', { name: '联系我们' })).toBeNull();
    });
});
