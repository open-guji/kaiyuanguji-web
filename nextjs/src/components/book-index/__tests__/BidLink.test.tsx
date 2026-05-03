import { render, screen } from '@testing-library/react';
import BidLink from '../BidLink';
import { SourceProvider } from '@/components/common/SourceContext';

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
