import { render, screen, fireEvent, waitFor } from '@testing-library/react';

jest.mock('@/components/layout/LayoutWrapper', () => ({ children }: { children: React.ReactNode }) => <div data-testid="shell">{children}</div>);
const mockReport = jest.fn();
jest.mock('@/lib/error-report', () => ({ reportError: (p: unknown) => mockReport(p) }));
const mockReload = jest.fn();
jest.mock('@/lib/auto-retry', () => ({
    ...jest.requireActual('@/lib/auto-retry'),
    reloadPage: () => mockReload(),
}));

import ErrorPage from '../error';
import GlobalError from '../global-error';

beforeEach(() => {
    window.sessionStorage.clear();
    mockReport.mockReset();
    mockReload.mockReset();
});

describe('站点错误页 app/error.tsx（overview#322）', () => {
    it('网络类错误：自动重新加载一次，不出错误页；同一地址第二次就出中文错误页', async () => {
        const err = new TypeError('Failed to fetch');
        const first = render(<ErrorPage error={err} reset={() => {}} />);
        await waitFor(() => expect(mockReload).toHaveBeenCalledTimes(1));
        expect(screen.queryByRole('alert')).toBeNull();
        first.unmount();

        render(<ErrorPage error={err} reset={() => {}} />);
        expect(await screen.findByRole('alert')).toBeInTheDocument();
        expect(mockReload).toHaveBeenCalledTimes(1);
        expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('页面没能打开');
    });

    it('客户端代码错误：不自动重试，直接出错误页；「重试」调 reset，「刷新页面」整页重载', async () => {
        const reset = jest.fn();
        render(<ErrorPage error={new TypeError("Cannot read properties of undefined (reading 'x')")} reset={reset} />);
        expect(await screen.findByRole('alert')).toBeInTheDocument();
        expect(mockReload).not.toHaveBeenCalled();
        fireEvent.click(screen.getByRole('button', { name: '重试' }));
        expect(reset).toHaveBeenCalledTimes(1);
        fireEvent.click(screen.getByRole('button', { name: '刷新页面' }));
        expect(mockReload).toHaveBeenCalledTimes(1);
        expect(screen.getByRole('link', { name: '回首页' })).toHaveAttribute('href', '/');
    });

    it('上报错误，带 digest 与是否自动重载', async () => {
        render(<ErrorPage error={Object.assign(new Error('boom'), { digest: 'd1' })} reset={() => {}} />);
        await waitFor(() => expect(mockReport).toHaveBeenCalled());
        expect(mockReport.mock.calls[0][0]).toMatchObject({ kind: 'react', message: expect.stringContaining('digest d1') });
    });
});

describe('根布局兜底 app/global-error.tsx', () => {
    // 组件自带 <html>／<body>，渲染进 jsdom 的 div 会有嵌套告警，与断言无关
    beforeEach(() => { jest.spyOn(console, 'error').mockImplementation(() => {}); });
    afterEach(() => { jest.restoreAllMocks(); });

    it('临时错误：自动重载，不出错误页', async () => {
        render(<GlobalError error={new TypeError('fetch failed')} reset={() => {}} />);
        await waitFor(() => expect(mockReload).toHaveBeenCalledTimes(1));
        expect(screen.queryByRole('alert')).toBeNull();
    });

    it('非临时错误：简体中文页与刷新按钮', async () => {
        render(<GlobalError error={new TypeError('x is not a function')} reset={() => {}} />);
        expect(await screen.findByText('页面没能打开')).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: '刷新页面' }));
        expect(mockReload).toHaveBeenCalledTimes(1);
    });
});
