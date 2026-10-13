/**
 * /feedback 列表页（N7）：「写反馈」打开弹窗，按类型筛选。数据是 mock 的示意数据。
 */
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import FeedbackPageContent from '../FeedbackPageContent';
import { FeedbackProvider } from '@/components/feedback/FeedbackProvider';

// 「相关条目」先查条目还在不在（overview#359 P2-10）：d59f20aowb9c 在，1evimvfwvwr9c 已删
const getEntry = jest.fn(async (id: string) => (id === 'd59f20aowb9c' ? { id, type: 'work', title: '史記' } : null));
jest.mock('@/components/common/SourceContext', () => ({ useSource: () => ({ source: 'cos' }) }));
jest.mock('@/lib/transport', () => ({ getTransport: () => ({ getEntry: (id: string) => getEntry(id) }) }));

const ITEMS = [
    { id: 'fb_1', type: 'bug', content: '（示例）作者朝代写错了', createdAt: '2026-09-20T01:00:00Z', status: 'resolved', reply: '已更正', resourceId: 'd59f20aowb9c' },
    { id: 'fb_2', type: 'suggestion', content: '（示例）希望能调行距', createdAt: '2026-09-21T01:00:00Z', status: 'in_progress' },
];

beforeEach(() => {
    global.fetch = jest.fn().mockResolvedValue({ json: async () => ({ success: true, items: ITEMS }) }) as never;
});

function renderPage() {
    return render(<FeedbackProvider><FeedbackPageContent /></FeedbackProvider>);
}

describe('FeedbackPageContent', () => {
    it('默认只列没处理完的；勾「显示已处理」才列已结的，取消再藏起来（overview#337 C1）', async () => {
        renderPage();
        expect(await screen.findByText('（示例）希望能调行距')).toBeInTheDocument();
        expect(screen.queryByText('（示例）作者朝代写错了')).not.toBeInTheDocument();
        const box = screen.getByRole('checkbox', { name: '显示已处理' });
        expect(box).not.toBeChecked();
        fireEvent.click(box);
        expect(screen.getByText('（示例）作者朝代写错了')).toBeInTheDocument();
        fireEvent.click(box);
        expect(screen.queryByText('（示例）作者朝代写错了')).not.toBeInTheDocument();
    });

    it('列出反馈：类型、相关条目、状态、站方回复', async () => {
        renderPage();
        await screen.findByText('（示例）希望能调行距');
        fireEvent.click(screen.getByRole('checkbox', { name: '显示已处理' }));
        expect(screen.getByText('（示例）作者朝代写错了')).toBeInTheDocument();
        expect(screen.getByText('已处理')).toBeInTheDocument();
        expect(screen.getByText('站方回复：已更正')).toBeInTheDocument();
        expect(await screen.findByRole('link', { name: '相关条目' })).toHaveAttribute('href', '/item/d59f20aowb9c');
        expect(screen.getByText('处理中')).toBeInTheDocument();
    });

    it('按类型筛选；「想参与」不列（不公开）', async () => {
        renderPage();
        await screen.findByText('（示例）希望能调行距');
        fireEvent.click(screen.getByRole('checkbox', { name: '显示已处理' }));
        const group = screen.getByRole('radiogroup', { name: '按类型筛选' });
        expect(within(group).getAllByRole('radio').map((r) => r.textContent)).toEqual(['全部', '内容有误', '补充资源', '功能建议']);
        fireEvent.click(within(group).getByRole('radio', { name: '功能建议' }));
        expect(screen.queryByText('（示例）作者朝代写错了')).not.toBeInTheDocument();
        expect(screen.getByText('（示例）希望能调行距')).toBeInTheDocument();
        fireEvent.click(within(group).getByRole('radio', { name: '补充资源' }));
        expect(screen.getByText('暂无反馈')).toBeInTheDocument();
    });

    it('「写反馈」打开弹窗，不带条目上下文', async () => {
        renderPage();
        await screen.findByText('（示例）希望能调行距');
        fireEvent.click(screen.getByRole('button', { name: '写反馈' }));
        const dialog = screen.getByRole('dialog', { name: '反馈' });
        expect(within(dialog).queryByText('关于')).not.toBeInTheDocument();
    });

    it('加载失败显示错误', async () => {
        global.fetch = jest.fn().mockRejectedValue(new Error('x')) as never;
        renderPage();
        expect(await screen.findByText('网络错误，请稍后重试')).toBeInTheDocument();
    });
});

describe('相关条目已失效（overview#359 P2-10）', () => {
    it('条目查不到：不出链接，写「相关条目已失效」；同一 id 只查一次', async () => {
        const gone = [
            { id: 'fb_3', type: 'bug', content: '（示例）甲', createdAt: '2026-09-22T01:00:00Z', status: 'pending', resourceId: '1evimvfwvwr9c' },
            { id: 'fb_4', type: 'bug', content: '（示例）乙', createdAt: '2026-09-23T01:00:00Z', status: 'pending', resourceId: '1evimvfwvwr9c' },
        ];
        global.fetch = jest.fn().mockResolvedValue({ json: async () => ({ success: true, items: gone }) }) as never;
        getEntry.mockClear();
        renderPage();
        expect(await screen.findAllByText('相关条目已失效')).toHaveLength(2);
        expect(screen.queryByRole('link', { name: /相关条目/ })).not.toBeInTheDocument();
        expect(getEntry.mock.calls.filter(([id]) => id === '1evimvfwvwr9c')).toHaveLength(1);
    });

    it('已认领的未结反馈回显「X已认领」；未认领、已结、未知块名都不显示（#605 步 4）', async () => {
        const claimed = [
            { id: 'fb_a', type: 'bug', content: '甲：已认领', createdAt: '2026-09-22T01:00:00Z', status: 'pending', assignee: 'text', claimedAt: '2026-09-22T02:00:00Z', category: 'typo' },
            { id: 'fb_b', type: 'bug', content: '乙：未认领', createdAt: '2026-09-22T01:00:00Z', status: 'pending', category: 'site' },
            { id: 'fb_c', type: 'bug', content: '丙：已结', createdAt: '2026-09-22T01:00:00Z', status: 'resolved', assignee: 'web' },
            { id: 'fb_d', type: 'bug', content: '丁：未知块', createdAt: '2026-09-22T01:00:00Z', status: 'pending', assignee: 'zzz' },
        ];
        global.fetch = jest.fn().mockResolvedValue({ json: async () => ({ success: true, items: claimed }) }) as never;
        const { container } = renderPage();
        await screen.findByText('甲：已认领');
        fireEvent.click(screen.getByRole('checkbox', { name: '显示已处理' }));
        expect(screen.getByText('丙：已结')).toBeInTheDocument();
        expect(screen.getByText('丁：未知块')).toBeInTheDocument();
        expect([...container.querySelectorAll('.og-fb-claimed')].map((e) => e.textContent)).toEqual(['文本已认领']);
    });

    it('提交完刷新列表时带 fresh=1 绕过边缘缓存；首次加载不带', async () => {
        jest.useFakeTimers();
        try {
            renderPage();
            await screen.findByText('（示例）希望能调行距');
            const urls = () => (global.fetch as jest.Mock).mock.calls.map((c) => String(c[0]));
            expect(urls().every((u) => !u.includes('fresh=1'))).toBe(true);
            fireEvent.click(screen.getByRole('button', { name: '写反馈' }));
            fireEvent.change(screen.getByRole('textbox', { name: '反馈内容' }), { target: { value: '新的一条' } });
            (global.fetch as jest.Mock).mockImplementation(async (u: string, init?: RequestInit) =>
                init?.method === 'POST'
                    ? { ok: true, json: async () => ({ success: true, id: 'fb_9_new' }) }
                    : { json: async () => ({ success: true, items: ITEMS }) });
            await act(async () => { fireEvent.click(screen.getByRole('button', { name: '提交' })); });
            await act(async () => { jest.advanceTimersByTime(600); });
            expect(urls().some((u) => u.includes('fresh=1'))).toBe(true);
        } finally {
            jest.useRealTimers();
        }
    });

    describe('「我的反馈」本机高亮（G5）', () => {
        afterEach(() => { window.localStorage.clear(); jest.restoreAllMocks(); });

        it('本机记过的 id 显示「我的」，别人的不显示', async () => {
            window.localStorage.setItem('guji.feedback.mine', JSON.stringify(['fb_2']));
            renderPage();
            const li = (await screen.findByText('（示例）希望能调行距')).closest('li') as HTMLElement;
            expect(within(li).getByText('我的')).toBeInTheDocument();
            fireEvent.click(screen.getByRole('checkbox', { name: '显示已处理' }));
            const other = screen.getByText('（示例）作者朝代写错了').closest('li') as HTMLElement;
            expect(within(other).queryByText('我的')).not.toBeInTheDocument();
        });

        it('localStorage 读取抛错时页面照常渲染，只是不高亮', async () => {
            jest.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied'); });
            renderPage();
            expect(await screen.findByText('（示例）希望能调行距')).toBeInTheDocument();
            expect(screen.queryByText('我的')).not.toBeInTheDocument();
        });
    });
});
