import { render, screen } from '@testing-library/react';
import BidLink from '../BidLink';

describe('BidLink', () => {
    it('renders a link with the correct href', () => {
        render(<BidLink id="test-id">Test Book</BidLink>);

        const link = screen.getByRole('link', { name: /test book/i });
        expect(link).toHaveAttribute('href', '/book-index/test-id');
    });

    it('applies custom className', () => {
        render(<BidLink id="test-id" className="custom-class">Test Book</BidLink>);

        const link = screen.getByRole('link', { name: /test book/i });
        expect(link).toHaveClass('custom-class');
    });
});
