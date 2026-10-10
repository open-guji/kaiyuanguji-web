import { render, screen, fireEvent, act } from '@testing-library/react';
import MovedBanner from '../MovedBanner';
import { MOVED_HASH } from '@/lib/site-hosts';

beforeEach(() => {
    sessionStorage.clear();
    window.history.replaceState(null, '', '/');
});

describe('MovedBanner（旧域名跳转后的窄横幅）', () => {
    it('地址没有迁移片段时什么也不渲染', () => {
        const { container } = render(<MovedBanner />);
        expect(container).toBeEmptyDOMElement();
    });

    it('带迁移片段时显示横幅，并把片段从地址栏摘掉', async () => {
        window.history.replaceState(null, '', `/item/abc?tab=x${MOVED_HASH}`);
        await act(async () => { render(<MovedBanner />); });
        expect(screen.getByTestId('moved-banner')).toHaveTextContent('www.openguji.com');
        expect(window.location.hash).toBe('');
        expect(window.location.pathname + window.location.search).toBe('/item/abc?tab=x');
    });

    it('片段被摘掉后（刷新、站内跳转）仍显示', async () => {
        window.history.replaceState(null, '', `/${MOVED_HASH}`);
        const first = render(<MovedBanner />);
        await act(async () => {});
        first.unmount();
        expect(window.location.hash).toBe('');
        await act(async () => { render(<MovedBanner />); });
        expect(screen.getByTestId('moved-banner')).toBeInTheDocument();
    });

    it('点 × 后本标签页内不再出现（即使又带了片段）', async () => {
        window.history.replaceState(null, '', `/${MOVED_HASH}`);
        const first = render(<MovedBanner />);
        await act(async () => {});
        fireEvent.click(screen.getByRole('button', { name: /关闭提示/ }));
        first.unmount();
        window.history.replaceState(null, '', `/b${MOVED_HASH}`);
        const { container } = render(<MovedBanner />);
        await act(async () => {});
        expect(container).toBeEmptyDOMElement();
    });
});
