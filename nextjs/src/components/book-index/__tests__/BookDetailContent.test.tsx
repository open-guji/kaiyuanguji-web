import { render, screen } from '@testing-library/react';
import type { ReadLinkContext } from 'book-index-ui';

// 只验网站传给三栏组件的接线：readLink 地址约定、railTop 检索框、extraTabs「数字化」
const captured: { props?: Record<string, unknown> } = {};
jest.mock('book-index-ui', () => ({
    BookDetailLayout: (props: Record<string, unknown>) => {
        captured.props = props;
        return <div>{props.railTop as React.ReactNode}</div>;
    },
}));
jest.mock('next/navigation', () => ({
    useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
    useSearchParams: () => new URLSearchParams(),
}));
jest.mock('@/components/layout/LayoutWrapper', () => ({
    __esModule: true,
    default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
jest.mock('@/lib/transport', () => ({ getTransport: () => ({}) }));
jest.mock('../CitationBar', () => ({ __esModule: true, default: () => null }));
jest.mock('../DigitalizationView', () => ({ __esModule: true, default: () => null }));
jest.mock('@/components/common/SourceContext', () => ({ useSource: () => ({ source: 'cos' }) }));

import BookDetailContent from '../BookDetailContent';
import { readerHref } from '@/lib/reader-route';

type ReadLink = (ctx: Partial<ReadLinkContext>) => string | null;

describe('BookDetailContent 接三栏组件', () => {
    beforeEach(() => {
        render(<BookDetailContent id="d59f20aowb9c" />);
    });

    it('readLink 按阅读页地址约定出地址', () => {
        const readLink = captured.props!.readLink as ReadLink;
        expect(readLink({ kind: 'collated' })).toBe('/item/d59f20aowb9c/read?kind=collated');
        expect(readLink({ kind: 'fulltext', fullTextKey: 'wikisource' }))
            .toBe('/item/d59f20aowb9c/read?kind=fulltext&key=wikisource');
    });

    it('readLink 与阅读页同一个 readerHref（Q7：地址只有一套拼法）', () => {
        const readLink = captured.props!.readLink as ReadLink;
        // 有 Work 全文时整理本也会带着 fullTextKey 进来，不能写进地址（P4）
        expect(readLink({ kind: 'collated', fullTextKey: 'wikisource-01' })).toBe('/item/d59f20aowb9c/read?kind=collated');
        for (const ctx of [{ kind: 'collated' as const }, { kind: 'fulltext' as const }, { kind: 'fulltext' as const, fullTextKey: 'a b' }]) {
            expect(readLink(ctx)).toBe(readerHref('d59f20aowb9c', { kind: ctx.kind, key: ctx.fullTextKey }));
        }
    });

    it('没有可读内容时不出「阅读全文」', () => {
        const readLink = captured.props!.readLink as ReadLink;
        expect(readLink({ kind: null })).toBeNull();
    });

    it('左栏顶部放站内检索框，回退表单 GET 到搜索页', () => {
        const box = screen.getByRole('searchbox', { name: '检索古籍索引' });
        expect(box.closest('form')).toHaveAttribute('action', '/book-index');
    });

    it('「数字化」照旧作为 extraTabs 传入', () => {
        const tabs = captured.props!.extraTabs as { key: string; label: string }[];
        expect(tabs.map((t) => [t.key, t.label])).toEqual([['digital', '数字化']]);
    });
});
