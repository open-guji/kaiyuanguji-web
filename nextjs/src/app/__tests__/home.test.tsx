import { fireEvent, render, screen, within } from '@testing-library/react';

const push = jest.fn();
jest.mock('next/navigation', () => ({
    usePathname: () => '/',
    useRouter: () => ({ push }),
}));
// 首页不测反馈浮钮（它来自 book-index-ui）
jest.mock('@/components/common/FeedbackWidget', () => () => null);

import HomePage from '../page';
import { HOME_FEATURES } from '@/components/home/features';

describe('首页（N1）', () => {
    beforeEach(() => push.mockClear());

    it('首屏：大标题 + 检索框 + 唯一主按钮「搜索」', () => {
        render(<HomePage />);
        expect(screen.getByRole('heading', { level: 1, name: '让科技赋予古籍数字生命' })).toBeInTheDocument();
        expect(screen.getByRole('searchbox', { name: '搜索古籍索引' })).toBeInTheDocument();
        const main = screen.getByRole('main');
        expect(within(main).getAllByRole('button').map((b) => b.textContent)).toEqual(['搜索']);
    });

    it('搜索跳到索引页并带上关键词', () => {
        render(<HomePage />);
        fireEvent.change(screen.getByRole('searchbox'), { target: { value: ' 史記 ' } });
        fireEvent.click(screen.getByRole('button', { name: '搜索' }));
        expect(push).toHaveBeenCalledWith(`/book-index?q=${encodeURIComponent('史記')}`);
    });

    it('只有「目录与版本聚类」「整理本阅读」标已上线，其余标规划中', () => {
        expect(HOME_FEATURES.filter((f) => f.live).map((f) => f.title)).toEqual([
            '目录与版本聚类',
            '整理本阅读',
        ]);
        render(<HomePage />);
        expect(screen.getAllByText('已上线')).toHaveLength(2);
        expect(screen.getAllByText('规划中')).toHaveLength(HOME_FEATURES.length - 2);
    });

    it('页尾「关于与联系」：三组文字链接，不加按钮（N6）', () => {
        render(<HomePage />);
        const band = screen.getByRole('region', { name: '一起把古籍做成开放数据' });
        expect(within(band).getAllByRole('link').map((a) => a.getAttribute('href'))).toEqual([
            '/about',
            '/contact',
            '/feedback',
        ]);
        expect(within(band).queryByRole('button')).not.toBeInTheDocument();
    });

    it('写明 CC0，不放二维码', () => {
        const { container } = render(<HomePage />);
        const main = screen.getByRole('main');
        expect(within(main).getByText(/CC0 公有领域/)).toBeInTheDocument();
        expect(container.innerHTML).not.toMatch(/二维码|qrcode|qr-code/i);
    });
});
