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

describe('分流：认领块／分类（#605 步 3）', () => {
    it('选认领块 → POST update 带 assignee；界面以后端返回的 claimedAt 为准显示', async () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (global as any).fetch = jest.fn(async (url: string, init?: RequestInit) => {
            if (init?.method === 'POST') {
                const body = JSON.parse(String(init.body));
                return { ok: true, json: async () => ({ success: true, item: { ...body, claimedAt: '2026-10-13T10:00:00.000Z' } }) };
            }
            return { ok: true, json: async () => ({ success: true, items: ITEMS, hasMore: false, cursor: '' }) };
        });
        render(<FeedbackView />);
        await waitFor(() => expect(screen.getByText('首页搜索点不动')).toBeInTheDocument());
        const card = screen.getByText('首页搜索点不动').closest('div.bg-white') as HTMLElement;
        fireEvent.change(within(card).getByLabelText('认领块'), { target: { value: 'web' } });
        await waitFor(() => expect(within(card).getByText(/网站 于 .* 认领/)).toBeInTheDocument());
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const post = (global as any).fetch.mock.calls.find((c: any[]) => c[1]?.method === 'POST');
        expect(JSON.parse(post[1].body)).toMatchObject({ action: 'update', id: 'fb_1_a', assignee: 'web' });
    });

    it('超 24h 未认领的显示徽章；旧记录分类下拉按 type 推（bug→网站）', async () => {
        render(<FeedbackView />);
        await waitFor(() => expect(screen.getByText('首页搜索点不动')).toBeInTheDocument());
        const card = screen.getByText('首页搜索点不动').closest('div.bg-white') as HTMLElement;
        expect(within(card).getByText('超 24h 未认领')).toBeInTheDocument();
        expect((within(card).getByLabelText('分类') as HTMLSelectElement).value).toBe('site');
    });

    it('认领后徽章消失', async () => {
        render(<FeedbackView />);
        await waitFor(() => expect(screen.getByText('首页搜索点不动')).toBeInTheDocument());
        const card = screen.getByText('首页搜索点不动').closest('div.bg-white') as HTMLElement;
        fireEvent.change(within(card).getByLabelText('认领块'), { target: { value: 'web' } });
        await waitFor(() => expect(within(card).queryByText('超 24h 未认领')).not.toBeInTheDocument());
    });
});

describe('管理页顶部 SLA 统计（#605 步 7）', () => {
    it('显示近 30 天已认领、超 24h 未认领、中位数；认领一条后数字更新', async () => {
        render(<FeedbackView />);
        await waitFor(() => expect(screen.getByText('首页搜索点不动')).toBeInTheDocument());
        const box = screen.getByTestId('sla-stats');
        // ITEMS 里两条 2026-09 的 bug／resource 都超 24h 未认领；contact 不计
        expect(box).toHaveTextContent('超 24h 未认领 2');
        expect(box).toHaveTextContent('认领耗时中位数 —');
        const card = screen.getByText('首页搜索点不动').closest('div.bg-white') as HTMLElement;
        fireEvent.change(within(card).getByLabelText('认领块'), { target: { value: 'web' } });
        await waitFor(() => expect(screen.getByTestId('sla-stats')).toHaveTextContent('超 24h 未认领 1'));
    });
});

describe('标记已改（G4）', () => {
    const card = () => screen.getByText('首页搜索点不动').closest('div.bg-white') as HTMLElement;
    const posted = () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const calls = ((global as any).fetch as jest.Mock).mock.calls.filter((c) => c[1]?.method === 'POST');
        return calls.map((c) => JSON.parse(String(c[1].body)));
    };
    async function open() {
        render(<FeedbackView />);
        await waitFor(() => expect(screen.getByText('首页搜索点不动')).toBeInTheDocument());
        fireEvent.click(within(card()).getByRole('button', { name: '标记已改' }));
        return within(screen.getByTestId('mark-done'));
    }

    it('缺回复或缺处理凭据时「确定」不可点；填对格式后一次回写 status／reply／resolvedRef', async () => {
        const panel = await open();
        const ok = panel.getByRole('button', { name: '确定' });
        expect(ok).toBeDisabled();
        fireEvent.change(panel.getByLabelText('给读者的回复'), { target: { value: '已更正' } });
        expect(ok).toBeDisabled(); // 已改必须有凭据
        fireEvent.change(panel.getByLabelText('处理凭据'), { target: { value: 'not a ref' } });
        expect(ok).toBeDisabled();
        expect(panel.getByText(/处理凭据格式应为/)).toBeInTheDocument();
        fireEvent.change(panel.getByLabelText('处理凭据'), { target: { value: 'open-guji/book-text@abc1234' } });
        expect(ok).toBeEnabled();
        fireEvent.click(ok);
        await waitFor(() => expect(posted()).toHaveLength(1));
        expect(posted()[0]).toMatchObject({ action: 'update', id: 'fb_1_a', status: 'resolved', reply: '已更正', resolvedRef: 'open-guji/book-text@abc1234' });
        await waitFor(() => expect(screen.queryByTestId('mark-done')).not.toBeInTheDocument());
        expect(screen.getByText('open-guji/book-text@abc1234')).toBeInTheDocument();
    });

    it('不采纳：理由必填，凭据可不填，回写 status=wontfix 且不带 resolvedRef', async () => {
        const panel = await open();
        fireEvent.click(panel.getByRole('radio', { name: '不采纳' }));
        const ok = panel.getByRole('button', { name: '确定' });
        expect(ok).toBeDisabled();
        fireEvent.change(panel.getByLabelText('给读者的回复'), { target: { value: '原书如此，不是错字' } });
        expect(ok).toBeEnabled();
        fireEvent.click(ok);
        await waitFor(() => expect(posted()).toHaveLength(1));
        expect(posted()[0]).toMatchObject({ status: 'wontfix', reply: '原书如此，不是错字' });
        expect(posted()[0]).not.toHaveProperty('resolvedRef');
    });

    it('已解决／不采纳／重复的条目没有「标记已改」，也不计入待处理', async () => {
        const settled = ['resolved', 'wontfix', 'duplicate'].map((status, i) => ({
            id: `fb_9${i}_s`, type: 'bug', content: `已结${status}`, pageUrl: '', createdAt: '2026-09-23T00:00:00.000Z', status, reply: '',
        }));
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (global as any).fetch = jest.fn(async () => ({ ok: true, json: async () => ({ success: true, items: [...ITEMS, ...settled], hasMore: false, cursor: '' }) }));
        render(<FeedbackView />);
        await waitFor(() => expect(screen.getByText('首页搜索点不动')).toBeInTheDocument());
        // 只有 fb_1_a、fb_2_b 两条待处理的非 contact 反馈（contact 在另一页签）→ 只有 2 个按钮
        expect(screen.getAllByRole('button', { name: '标记已改' })).toHaveLength(2);
        for (const s of settled) {
            const c = screen.getByText(s.content).closest('div.bg-white') as HTMLElement;
            expect(within(c).queryByRole('button', { name: '标记已改' })).not.toBeInTheDocument();
        }
        // 顶部统计：待处理 3（fb_1_a、fb_2_b、contact fb_3_c），已结的 3 条不算
        expect(screen.getByText(/待处理 3 ·/)).toBeInTheDocument();
    });

    it('取消不发请求；已结的条目没有「标记已改」；contact 没有', async () => {
        const panel = await open();
        fireEvent.click(panel.getByRole('button', { name: '取消' }));
        expect(screen.queryByTestId('mark-done')).not.toBeInTheDocument();
        expect(posted()).toHaveLength(0);
        fireEvent.click(screen.getByText(/联系我们/));
        expect(screen.queryByRole('button', { name: '标记已改' })).not.toBeInTheDocument();
    });
});
