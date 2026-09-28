/**
 * /feedback 列表页（N7）：「写反馈」打开弹窗，按类型筛选。数据是 mock 的示意数据。
 */
import { fireEvent, render, screen, within } from '@testing-library/react';
import FeedbackPageContent from '../FeedbackPageContent';
import { FeedbackProvider } from '@/components/feedback/FeedbackProvider';

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
    it('列出反馈：类型、相关条目、状态、站方回复', async () => {
        renderPage();
        expect(await screen.findByText('（示例）作者朝代写错了')).toBeInTheDocument();
        expect(screen.getByText('已处理')).toBeInTheDocument();
        expect(screen.getByText('站方回复：已更正')).toBeInTheDocument();
        expect(screen.getByRole('link', { name: '相关条目' })).toHaveAttribute('href', '/item/d59f20aowb9c');
        expect(screen.getByText('处理中')).toBeInTheDocument();
    });

    it('按类型筛选；「想参与」不列（不公开）', async () => {
        renderPage();
        await screen.findByText('（示例）作者朝代写错了');
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
        await screen.findByText('（示例）作者朝代写错了');
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
