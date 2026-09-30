import { fireEvent, render, screen, within } from '@testing-library/react';

const push = jest.fn();
jest.mock('next/navigation', () => ({
    usePathname: () => '/',
    useRouter: () => ({ push }),
}));

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

    it('只有「古籍元数据」「资源收集」标已上线，其余标规划中；六项标题照用户意见', () => {
        expect(HOME_FEATURES.map((f) => f.title)).toEqual([
            '古籍元数据',
            '资源收集',
            '图文对读',
            '全文检索',
            '协同校对',
            '古籍专用模型',
        ]);
        expect(HOME_FEATURES.filter((f) => f.live).map((f) => f.title)).toEqual(['古籍元数据', '资源收集']);
        render(<HomePage />);
        expect(screen.getAllByText('已上线')).toHaveLength(2);
        expect(screen.getAllByText('规划中')).toHaveLength(HOME_FEATURES.length - 2);
        // 「资源收集」的说明：收集网上的文字资源和影印资源
        expect(HOME_FEATURES[1].text).toMatch(/文字资源和影印资源/);
    });

    it('搜索框下面只有三个例子：史记→作品页、四库全书→丛编页、红楼梦程甲本→阅读页；没有「看一个例子」', () => {
        render(<HomePage />);
        const under = document.querySelector('.home-under') as HTMLElement;
        const links = within(under).getAllByRole('link');
        expect(links.map((a) => [a.textContent, a.getAttribute('href')])).toEqual([
            ['史记', '/item/d59f20aowb9c'],
            ['四库全书', '/item/8rlb6yi1ecqo'],
            ['红楼梦程甲本', '/read/96kzkdm8e8?kind=fulltext'],
        ]);
        expect(screen.getByRole('main').textContent).not.toMatch(/看一个例子|读整理本/);
    });

    it('「一起把古籍做成开放数据」一整段已删，页尾的三个入口在页脚里都有', () => {
        render(<HomePage />);
        expect(screen.queryByRole('region', { name: '一起把古籍做成开放数据' })).not.toBeInTheDocument();
        expect(screen.queryByText('一起把古籍做成开放数据')).not.toBeInTheDocument();
        const footer = within(screen.getByRole('contentinfo'));
        for (const href of ['/about', '/contact', '/feedback']) {
            expect(footer.getAllByRole('link').map((a) => a.getAttribute('href'))).toContain(href);
        }
    });

    it('「文本开放、代码开源」两栏：各自给出两个仓库的链接和说明', () => {
        render(<HomePage />);
        const open = screen.getByRole('region', { name: '开放' });
        const cols = open.querySelectorAll('.home-open-col');
        expect(cols).toHaveLength(2);
        expect(within(cols[0] as HTMLElement).getByRole('heading', { name: '文本开放' })).toBeInTheDocument();
        expect(within(cols[1] as HTMLElement).getByRole('heading', { name: '代码开源' })).toBeInTheDocument();
        const repoLinks = (col: Element) =>
            within(col as HTMLElement)
                .getAllByRole('link')
                .map((a) => a.getAttribute('href'))
                .filter((h) => h!.startsWith('https://github.com/open-guji/'));
        expect(repoLinks(cols[0])).toEqual([
            'https://github.com/open-guji/book-text',
            'https://github.com/open-guji/book-index',
        ]);
        expect(repoLinks(cols[1])).toEqual([
            'https://github.com/open-guji/luatex-cn',
            'https://github.com/open-guji/bookget-py',
        ]);
        for (const r of ['book-text', 'book-index', 'luatex-cn', 'bookget-py']) {
            expect(within(open).getByRole('link', { name: r })).toBeInTheDocument();
        }
    });

    it('写明 CC0；二维码只在页脚，正文里没有（N6）', () => {
        render(<HomePage />);
        const main = screen.getByRole('main');
        expect(within(main).getByText(/CC0 公有领域/)).toBeInTheDocument();
        expect(main.innerHTML).not.toMatch(/二维码|qrcode|qr-code/i);
        expect(within(screen.getByRole('contentinfo')).getByRole('img', { name: /二维码/ })).toBeInTheDocument();
    });

    it('v3：已上线的卡片带入口、规划中的没有；许可徽标在两栏标题前；不出「看一个例子」', () => {
        render(<HomePage />);
        const live = document.querySelectorAll('.home-feature.is-live');
        expect(live).toHaveLength(2);
        expect(document.querySelectorAll('.home-feature:not(.is-live)')).toHaveLength(HOME_FEATURES.length - 2);
        expect(within(live[0] as HTMLElement).getByRole('link', { name: /进入古籍总目/ }).getAttribute('href')).toBe('/catalog');
        expect(document.querySelectorAll('.home-feature:not(.is-live) a')).toHaveLength(0);
        expect(screen.getByLabelText('许可：CC0').textContent).toBe('CC0');
        expect(screen.getByLabelText('许可：Apache-2.0').textContent).toBe('Apache-2.0');
        expect(screen.getByRole('search')).toBeInTheDocument();
    });
});
