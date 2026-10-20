import { render, screen, fireEvent, act } from '@testing-library/react';
import ProofingNotice from '../ProofingNotice';

beforeEach(() => sessionStorage.clear());

describe('ProofingNotice（本书正在校对）', () => {
    it('没有 vol（未开校对）什么也不渲染', async () => {
        const { container } = render(<ProofingNotice id="b1" />);
        await act(async () => {});
        expect(container).toBeEmptyDOMElement();
    });
    it('有 vol 时显示并指向精校页', async () => {
        render(<ProofingNotice id="b1" vol="001" />);
        await act(async () => {});
        expect(screen.getByTestId('proofing-notice')).toHaveTextContent('这一章正在校对');
        expect(screen.getByRole('link', { name: '参与校对 →' })).toHaveAttribute('href', '/proofing/b1/001');
    });
    it('v1.x（只有 feedbackVol）指向反馈页；校对中优先于反馈', async () => {
        const { unmount } = render(<ProofingNotice id="b1" feedbackVol="002" />);
        await act(async () => {});
        expect(screen.getByTestId('feedback-notice')).toHaveTextContent('这一章已校定');
        expect(screen.getByRole('link', { name: '读者反馈 →' })).toHaveAttribute('href', '/feedback/text?book=b1&vol=002');
        unmount();
        render(<ProofingNotice id="b1" vol="001" feedbackVol="001" />);
        await act(async () => {});
        expect(screen.getByRole('link', { name: '参与校对 →' })).toHaveAttribute('href', '/proofing/b1/001');
        expect(screen.queryByTestId('feedback-notice')).toBeNull();
    });
    it('点 × 后同标签页不再出现', async () => {
        const first = render(<ProofingNotice id="b1" vol="001" />);
        await act(async () => {});
        fireEvent.click(screen.getByRole('button', { name: '关闭提示' }));
        first.unmount();
        const { container } = render(<ProofingNotice id="b1" vol="001" />);
        await act(async () => {});
        expect(container).toBeEmptyDOMElement();
    });
});
