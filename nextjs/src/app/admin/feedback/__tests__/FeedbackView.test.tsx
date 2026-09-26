/**
 * G-23 第二批 §一·9：/admin/feedback 补全——改类型、改状态（含标重复）、
 * contact 单独页签、筛选、pageUrl 域名过滤（第二批 §一·10，后台侧）。
 */
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import FeedbackView from '../FeedbackView';

const ITEMS = [
    {
        id: 'fb_1_a', type: 'bug', content: '首页搜索点不动', pageUrl: 'https://www.kaiyuanguji.com/search',
        createdAt: '2026-09-20T00:00:00.000Z', status: 'pending', reply: '',
    },
    {
        id: 'fb_2_b', type: 'resource', content: '建议加一个版本', pageUrl: 'https://evil.example/phish',
        createdAt: '2026-09-21T00:00:00.000Z', status: 'pending', reply: '',
    },
    {
        id: 'fb_3_c', type: 'contact', content: '想参与整理项目', contact: 'reader@example.com',
        createdAt: '2026-09-22T00:00:00.000Z', status: 'pending', reply: '', visibility: 'hidden',
    },
];

function mockFetchSequence() {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (global as any).fetch = jest.fn(async (url: string, init?: RequestInit) => {
        if (init?.method === 'POST') {
            const body = JSON.parse(String(init.body));
            return { ok: true, json: async () => ({ success: true, item: body }) };
        }
        // fetchAllPages 只请求一页就把 hasMore 关掉
        return { ok: true, json: async () => ({ success: true, items: ITEMS, hasMore: false, cursor: '' }) };
    });
}

beforeEach(() => {
    mockFetchSequence();
    // jsdom 默认 origin 是 http://localhost；改用 defineProperty 换成生产域名，
    // 好让「本站地址」与测试数据里的 https://www.kaiyuanguji.com/... 对得上
    Object.defineProperty(window, 'location', {
        value: { ...window.location, href: 'https://www.kaiyuanguji.com/admin/feedback', hostname: 'www.kaiyuanguji.com' },
        writable: true,
    });
});

afterEach(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (global as any).fetch;
});

describe('页签：反馈 / 联系我们', () => {
    it('contact 类型只出现在联系我们页签，不出现在反馈页签', async () => {
        render(<FeedbackView />);
        await waitFor(() => expect(screen.getByText('首页搜索点不动')).toBeInTheDocument());
        expect(screen.queryByText('想参与整理项目')).not.toBeInTheDocument();

        fireEvent.click(screen.getByText(/联系我们/));
        expect(screen.getByText('想参与整理项目')).toBeInTheDocument();
        expect(screen.queryByText('首页搜索点不动')).not.toBeInTheDocument();
        // contact 类型不提供「隐藏/恢复公开」按钮（永远不公开，没有意义）
        expect(screen.queryByRole('button', { name: '恢复公开' })).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: '隐藏' })).not.toBeInTheDocument();
    });
});

describe('改类型', () => {
    it('切换类型下拉框会发起 update 请求', async () => {
        render(<FeedbackView />);
        await waitFor(() => expect(screen.getByText('首页搜索点不动')).toBeInTheDocument());
        const card = screen.getByText('首页搜索点不动').closest('div.bg-white')!;
        const typeSelect = within(card as HTMLElement).getAllByRole('combobox')[0];
        fireEvent.change(typeSelect, { target: { value: 'suggestion' } });
        await waitFor(() => {
            const calls = (global.fetch as jest.Mock).mock.calls.filter((c) => c[1]?.method === 'POST');
            expect(calls.length).toBeGreaterThan(0);
            const body = JSON.parse(calls[calls.length - 1][1].body);
            expect(body).toMatchObject({ action: 'update', id: 'fb_1_a', type: 'suggestion' });
        });
    });
});

describe('隐藏 / 恢复公开', () => {
    it('点击隐藏发起 visibility:hidden 的 update', async () => {
        render(<FeedbackView />);
        await waitFor(() => expect(screen.getByText('首页搜索点不动')).toBeInTheDocument());
        const card = screen.getByText('首页搜索点不动').closest('div.bg-white')!;
        fireEvent.click(within(card as HTMLElement).getByText('隐藏'));
        await waitFor(() => {
            const calls = (global.fetch as jest.Mock).mock.calls.filter((c) => c[1]?.method === 'POST');
            const body = JSON.parse(calls[calls.length - 1][1].body);
            expect(body).toMatchObject({ action: 'update', id: 'fb_1_a', visibility: 'hidden' });
        });
        await waitFor(() => expect(within(card as HTMLElement).getByText('恢复公开')).toBeInTheDocument());
    });
});

describe('标重复', () => {
    it('把状态改成「重复」会弹出目标选择器，选定后发起带 duplicateOf 的 update', async () => {
        render(<FeedbackView />);
        await waitFor(() => expect(screen.getByText('首页搜索点不动')).toBeInTheDocument());
        const card = screen.getByText('首页搜索点不动').closest('div.bg-white')!;
        const statusSelect = within(card as HTMLElement).getAllByRole('combobox')[1];
        fireEvent.change(statusSelect, { target: { value: 'duplicate' } });

        expect(screen.getByText('选择目标反馈…')).toBeInTheDocument();
        const targetSelect = screen.getByText('选择目标反馈…').closest('select')!;
        fireEvent.change(targetSelect, { target: { value: 'fb_2_b' } });
        fireEvent.click(screen.getByText('确定'));

        await waitFor(() => {
            const calls = (global.fetch as jest.Mock).mock.calls.filter((c) => c[1]?.method === 'POST');
            const body = JSON.parse(calls[calls.length - 1][1].body);
            expect(body).toMatchObject({ action: 'update', id: 'fb_1_a', status: 'duplicate', duplicateOf: 'fb_2_b' });
        });
    });
});

describe('筛选', () => {
    it('按类型筛选：只看「资源」时反馈页签只剩一条', async () => {
        render(<FeedbackView />);
        await waitFor(() => expect(screen.getByText('首页搜索点不动')).toBeInTheDocument());
        const typeFilter = screen.getByText('类型').closest('label')!.querySelector('select')!;
        fireEvent.change(typeFilter, { target: { value: 'resource' } });
        expect(screen.queryByText('首页搜索点不动')).not.toBeInTheDocument();
        expect(screen.getByText('建议加一个版本')).toBeInTheDocument();
    });
});

describe('pageUrl 域名过滤（第二批 §一·10）', () => {
    it('本站地址渲染为链接；外站地址只显示文本，不渲染 <a>', async () => {
        render(<FeedbackView />);
        await waitFor(() => expect(screen.getByText('首页搜索点不动')).toBeInTheDocument());

        const ownCard = screen.getByText('首页搜索点不动').closest('div.bg-white')!;
        expect(within(ownCard as HTMLElement).getByRole('link', { name: /kaiyuanguji\.com\/search/ })).toBeInTheDocument();

        const foreignCard = screen.getByText('建议加一个版本').closest('div.bg-white')!;
        expect(within(foreignCard as HTMLElement).queryByRole('link')).not.toBeInTheDocument();
        expect(within(foreignCard as HTMLElement).getByText(/evil\.example/)).toBeInTheDocument();
    });
});
