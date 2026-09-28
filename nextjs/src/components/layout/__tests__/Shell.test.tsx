import { fireEvent, render, screen, within } from '@testing-library/react';

let mockPath = '/';
jest.mock('next/navigation', () => ({
    usePathname: () => mockPath,
    useRouter: () => ({ push: jest.fn() }),
}));

import Navbar from '../Navbar';
import MobileDrawer from '../MobileDrawer';
import Footer from '../Footer';
import LayoutWrapper from '../LayoutWrapper';
import { isCurrent, MAIN_CONTENT_ID, MOBILE_DRAWER_ID, MORE_LINKS, PRIMARY_LINKS } from '../nav-links';

describe('isCurrent', () => {
    it('首页只精确匹配', () => {
        expect(isCurrent('/', '/')).toBe(true);
        expect(isCurrent('/book-index', '/')).toBe(false);
    });
    it('子路径算当前，前缀相同的兄弟路径不算', () => {
        expect(isCurrent('/tools/shuowen', '/tools')).toBe(true);
        expect(isCurrent('/toolkit', '/tools')).toBe(false);
    });
});

describe('Navbar（N1 顶栏）', () => {
    it('主导航只有样张定的主干入口', () => {
        mockPath = '/';
        render(<Navbar />);
        const nav = screen.getByRole('navigation', { name: '主导航' });
        expect(within(nav).getAllByRole('link').map((a) => a.textContent)).toEqual(
            PRIMARY_LINKS.map((l) => l.label),
        );
    });

    it('顶栏有「古籍总目」（/catalog），「阅读页」不单独进导航（WEB2）', () => {
        mockPath = '/catalog';
        render(<Navbar />);
        const nav = screen.getByRole('navigation', { name: '主导航' });
        expect(within(nav).getAllByRole('link').map((a) => a.textContent)).toEqual(['首页', '古籍总目', '古籍索引', '关于']);
        expect(within(nav).getByRole('link', { name: '古籍总目' })).toHaveAttribute('href', '/catalog');
        expect(within(nav).getByRole('link', { name: '古籍总目' })).toHaveAttribute('aria-current', 'page');
        expect(within(nav).queryByRole('link', { name: /阅读/ })).toBeNull();
    });

    it('当前项用 aria-current 标记（样式是一条朱色下划线），且只有一个', () => {
        mockPath = '/book-index';
        render(<Navbar />);
        const nav = screen.getByRole('navigation', { name: '主导航' });
        const current = within(nav)
            .getAllByRole('link')
            .filter((a) => a.getAttribute('aria-current') === 'page');
        expect(current.map((a) => a.textContent)).toEqual(['古籍索引']);
    });

    it('首页模式页头透明浮在首屏上', () => {
        const { container } = render(<Navbar onHero />);
        expect(container.querySelector('header')).toHaveClass('og-nav--hero');
    });

    it('汉堡按钮触发抽屉', () => {
        const onToggle = jest.fn();
        render(<Navbar onMobileMenuToggle={onToggle} />);
        fireEvent.click(screen.getByRole('button', { name: '打开菜单' }));
        expect(onToggle).toHaveBeenCalled();
    });
});

describe('MobileDrawer', () => {
    it('关着时不渲染', () => {
        const { container } = render(<MobileDrawer isOpen={false} onClose={() => {}} />);
        expect(container).toBeEmptyDOMElement();
    });

    it('抽屉与顶栏同步有「古籍总目」', () => {
        mockPath = '/';
        render(<MobileDrawer isOpen onClose={() => {}} />);
        expect(screen.getByRole('link', { name: '古籍总目' })).toHaveAttribute('href', '/catalog');
    });

    it('打开后顶栏拿掉的入口仍能在「更多」里点到', () => {
        mockPath = '/';
        render(<MobileDrawer isOpen onClose={() => {}} />);
        for (const l of [...PRIMARY_LINKS, ...MORE_LINKS]) {
            expect(screen.getByRole('link', { name: l.label })).toHaveAttribute('href', l.href);
        }
    });

    it('Esc 关闭', () => {
        const onClose = jest.fn();
        render(<MobileDrawer isOpen onClose={onClose} />);
        fireEvent.keyDown(window, { key: 'Escape' });
        expect(onClose).toHaveBeenCalled();
    });
});

describe('无障碍（B9 / A2）', () => {
    beforeEach(() => {
        mockPath = '/';
    });

    it('汉堡按钮带 aria-expanded / aria-controls，随抽屉开合变化', () => {
        render(<LayoutWrapper>正文</LayoutWrapper>);
        const burger = screen.getByRole('button', { name: '打开菜单' });
        expect(burger).toHaveAttribute('aria-controls', MOBILE_DRAWER_ID);
        expect(burger).toHaveAttribute('aria-expanded', 'false');
        fireEvent.click(burger);
        expect(burger).toHaveAttribute('aria-expanded', 'true');
        expect(document.getElementById(MOBILE_DRAWER_ID)).toBeInTheDocument();
    });

    it('抽屉是模态对话框：打开时焦点进来，Tab 困在里面，关闭后焦点回到汉堡按钮', () => {
        render(<LayoutWrapper>正文</LayoutWrapper>);
        const burger = screen.getByRole('button', { name: '打开菜单' });
        burger.focus();
        fireEvent.click(burger);

        const dialog = screen.getByRole('dialog', { name: '站点菜单' });
        expect(dialog).toHaveAttribute('aria-modal', 'true');
        const close = within(dialog).getByRole('button', { name: '关闭菜单' });
        expect(close).toHaveFocus();

        // 最后一个可聚焦元素上按 Tab → 回到第一个
        const focusables = dialog.querySelectorAll<HTMLElement>('a[href], button');
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        last.focus();
        fireEvent.keyDown(window, { key: 'Tab' });
        expect(first).toHaveFocus();
        // 第一个上按 Shift+Tab → 到最后一个
        fireEvent.keyDown(window, { key: 'Tab', shiftKey: true });
        expect(last).toHaveFocus();

        fireEvent.keyDown(window, { key: 'Escape' });
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
        expect(burger).toHaveFocus();
    });

    it('「跳到正文」指向 main', () => {
        render(<LayoutWrapper>正文</LayoutWrapper>);
        expect(screen.getByRole('link', { name: '跳到正文' })).toHaveAttribute('href', `#${MAIN_CONTENT_ID}`);
        expect(screen.getByRole('main')).toHaveAttribute('id', MAIN_CONTENT_ID);
    });

    it('没有右下角浮钮（N7 去掉），反馈入口在顶栏右侧，打开的是模态弹窗', () => {
        const { container } = render(<LayoutWrapper>正文</LayoutWrapper>);
        expect(container.querySelector('.og-fab-space')).not.toBeInTheDocument();
        const header = container.querySelector('header')!;
        const fb = within(header).getByRole('button', { name: '反馈' });
        fb.focus();
        fireEvent.click(fb);
        const dialog = screen.getByRole('dialog', { name: '反馈' });
        expect(dialog).toHaveAttribute('aria-modal', 'true');
        fireEvent.keyDown(window, { key: 'Escape' });
        expect(screen.queryByRole('dialog', { name: '反馈' })).not.toBeInTheDocument();
        expect(fb).toHaveFocus();
    });
});

describe('Footer', () => {
    it('写明文本 CC0、代码 Apache-2.0，保留备案号', () => {
        render(<Footer />);
        expect(screen.getByText(/CC0/)).toBeInTheDocument();
        expect(screen.getByText(/Apache-2\.0/)).toBeInTheDocument();
        expect(screen.getByRole('link', { name: /冀ICP备/ })).toBeInTheDocument();
    });

    it('顶栏拿掉的入口在页脚保留', () => {
        render(<Footer />);
        for (const l of MORE_LINKS) {
            expect(screen.getByRole('link', { name: l.label })).toHaveAttribute('href', l.href);
        }
    });
});
