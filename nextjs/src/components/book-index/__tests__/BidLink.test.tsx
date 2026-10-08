import { render, screen } from '@testing-library/react';
import BidLink from '../BidLink';
import { SourceProvider } from '@/components/common/SourceContext';

const mockGetEntry = jest.fn().mockResolvedValue(null);
jest.mock('@/lib/transport', () => ({ getTransport: () => ({ getEntry: mockGetEntry }) }));

function renderInProvider(node: React.ReactElement) {
    return render(<SourceProvider>{node}</SourceProvider>);
}

describe('BidLink', () => {
    it('renders a link with the correct href', () => {
        renderInProvider(<BidLink id="test-id">Test Book</BidLink>);

        const link = screen.getByRole('link', { name: /test book/i });
        expect(link).toHaveAttribute('href', '/book-index?id=test-id');
    });

    it('applies custom className', () => {
        renderInProvider(<BidLink id="test-id" className="custom-class">Test Book</BidLink>);

        const link = screen.getByRole('link', { name: /test book/i });
        expect(link).toHaveClass('custom-class');
    });
});

describe('BidLink：给了标题就不取条目（F4-5 批次 0.2）', () => {
    beforeEach(() => mockGetEntry.mockClear());

    it('传了 label：不调 getEntry，图标类型由 id 位段判', () => {
        const { container } = renderInProvider(<BidLink id="988g3gl3if">某本</BidLink>);
        expect(mockGetEntry).not.toHaveBeenCalled();
        expect(container.querySelector('svg')).not.toBeNull();
    });

    it('没传 label（或 label 就是 id 占位）：照旧取条目', () => {
        renderInProvider(<BidLink id="988g3f0wsu" />);
        renderInProvider(<BidLink id="d59f20aowb9c">d59f20aowb9c</BidLink>);
        expect(mockGetEntry).toHaveBeenCalledTimes(2);
    });
});
