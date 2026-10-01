/**
 * CitationBar：条目页页脚的版本信息；N7 在末尾加「这条有误？」，打开反馈弹窗并带上本条目。
 */
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import CitationBar from '../CitationBar';
import { FeedbackProvider, useFeedback } from '@/components/feedback/FeedbackProvider';

const WORK = 'd59f20aowb9c';

function transportWith(detail: Record<string, unknown> | null) {
    return { getItem: jest.fn().mockResolvedValue(detail) } as never;
}

describe('CitationBar', () => {
    it('显示修订号与日期', async () => {
        render(<FeedbackProvider><CitationBar id={WORK} transport={transportWith({ revision: '1.0.3', revised_at: '2026-08-31', title: '史记' })} /></FeedbackProvider>);
        expect(await screen.findByText(/rev\. 1\.0\.3/)).toHaveTextContent('最近校订 2026-08-31');
    });

    it('「这条有误？」打开反馈弹窗，带上书名 · 类型 · id，类型是「内容有误」', async () => {
        render(<FeedbackProvider><CitationBar id={WORK} transport={transportWith({ revision: '1.0.3', title: '史记' })} /></FeedbackProvider>);
        await screen.findByText(/rev\. 1\.0\.3/);
        fireEvent.click(screen.getByRole('button', { name: '这条有误？' }));
        const dialog = screen.getByRole('dialog', { name: '反馈' });
        expect(within(dialog).getByText(`史记 · 作品 · ${WORK}`)).toBeInTheDocument();
        expect(within(dialog).getByRole('radio', { name: '内容有误' })).toHaveAttribute('aria-checked', 'true');
    });

    it('草稿条目（没有修订号）也有「这条有误？」', async () => {
        render(<FeedbackProvider><CitationBar id={WORK} transport={transportWith({})} /></FeedbackProvider>);
        await act(async () => {});
        expect(screen.getByText(/draft/)).toBeInTheDocument();
        expect(screen.getByRole('button', { name: '这条有误？' })).toBeInTheDocument();
    });

    it('把本条目登记为页面上下文：从导航栏打开也带上', async () => {
        function NavFeedback() {
            const { open } = useFeedback();
            return <button type="button" onClick={() => open()}>反馈</button>;
        }
        render(
            <FeedbackProvider>
                <NavFeedback />
                <CitationBar id={WORK} transport={transportWith({ revision: '1.0.3', title: '史记' })} />
            </FeedbackProvider>,
        );
        await screen.findByText(/rev\. 1\.0\.3/);
        fireEvent.click(screen.getByRole('button', { name: '反馈' }));
        expect(within(screen.getByRole('dialog')).getByText(`史记 · 作品 · ${WORK}`)).toBeInTheDocument();
    });
});
