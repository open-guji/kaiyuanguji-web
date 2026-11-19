import { render, screen } from '@testing-library/react';
import TenureList, { tenureModeOf } from '../TenureList';
import { SourceProvider } from '@/components/common/SourceContext';
import type { IndexDetailData } from 'book-index-ui';

jest.mock('@/lib/transport', () => ({ getTransport: () => ({ getEntry: jest.fn().mockResolvedValue(null) }) }));

const d = (o: Record<string, unknown>) => o as unknown as IndexDetailData;

describe('tenureModeOf', () => {
    it('官职有 _holders → holders；地名有 _officials → officials', () => {
        expect(tenureModeOf(d({ subtype: 'office', _holders: [{ id: 'a' }] }))).toBe('holders');
        expect(tenureModeOf(d({ subtype: 'place', _officials: [{ id: 'a' }] }))).toBe('officials');
    });
    it('没有数据、空数组、类型不符都不出标签', () => {
        expect(tenureModeOf(d({ subtype: 'office' }))).toBeNull();
        expect(tenureModeOf(d({ subtype: 'office', _holders: [] }))).toBeNull();
        expect(tenureModeOf(d({ subtype: 'people', _holders: [{ id: 'a' }] }))).toBeNull();
        expect(tenureModeOf(null)).toBeNull();
    });
});

describe('TenureList', () => {
    const wrap = (n: React.ReactElement) => render(<SourceProvider>{n}</SourceProvider>);

    it('历任者：人名、朝代、任职地、原文、年份', () => {
        wrap(<TenureList detail={d({
            subtype: 'office',
            _holders: [
                { id: 'p1', name: '董樞', dyn: '北宋', text: '知欽州', start: 1049, end: 1051, place: { id: 'pl1', name: '欽州' } },
                { id: 'p2', name: '劉保勳', text: '知州' },
            ],
        })} />);
        expect(screen.getByRole('link', { name: '董樞' })).toHaveAttribute('href', '/item/p1');
        expect(screen.getByRole('link', { name: '欽州' })).toHaveAttribute('href', '/item/pl1');
        expect(screen.getByText(/1049–1051/)).toBeInTheDocument();
        expect(screen.getByText(/年份不详/)).toBeInTheDocument();
        expect(screen.getByTestId('tenure-total').textContent).toContain('共 2 条');
    });

    it('超过卡数：提示总数', () => {
        wrap(<TenureList detail={d({
            subtype: 'place',
            _officials: [{ id: 'p1', name: '甲', office: { id: 'o1', name: '知州' }, start: 1100 }],
            _officials_total: 412,
        })} />);
        const total = screen.getByTestId('tenure-total').textContent ?? '';
        expect(total).toContain('412');
        expect(total).toContain('只列前 1 条');
        expect(screen.getByRole('link', { name: '知州' })).toHaveAttribute('href', '/item/o1');
    });
});
