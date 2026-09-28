import { fireEvent, render, screen, within } from '@testing-library/react';

let mockPath = '/';
jest.mock('next/navigation', () => ({
    usePathname: () => mockPath,
    useRouter: () => ({ push: jest.fn() }),
}));

import Navbar from '../Navbar';
import MobileDrawer from '../MobileDrawer';
import Footer from '../Footer';
import { isCurrent, MORE_LINKS, PRIMARY_LINKS } from '../nav-links';

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
