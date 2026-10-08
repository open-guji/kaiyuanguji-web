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
const mockGetEntry = jest.fn(() => Promise.resolve(null));
jest.mock('next/navigation', () => ({
    useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
    useSearchParams: () => new URLSearchParams(),
}));
jest.mock('@/components/layout/LayoutWrapper', () => ({
    __esModule: true,
    default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
jest.mock('@/lib/transport', () => ({ getTransport: () => ({ getEntry: mockGetEntry }) }));
jest.mock('../CitationBar', () => ({ __esModule: true, default: () => null }));
jest.mock('../DigitalizationView', () => ({ __esModule: true, default: () => null }));
jest.mock('@/components/common/SourceContext', () => ({ useSource: () => ({ source: 'cos' }) }));

import BookDetailContent from '../BookDetailContent';
import { readerPath } from '@/lib/reader-route';

type ReadLink = (ctx: Partial<ReadLinkContext>) => string | null;

describe('BookDetailContent 接三栏组件', () => {
    beforeEach(() => {
        render(<BookDetailContent id="d59f20aowb9c" />);
    });

    const withText = (over: Partial<ReadLinkContext> = {}): Partial<ReadLinkContext> => ({ detail: { text_count: 2 } as never, ...over });

    it('条目有可读文本（text_count>0）：阅读全文进主版本的阅读页，路径式、不带 kind／key（overview#307）', () => {
        const readLink = captured.props!.readLink as ReadLink;
        expect(readLink(withText())).toBe('/read/d59f20aowb9c');
        // bim 的 ctx.kind 是按旧目录探测的，迁移后是 null 也照样出按钮
        expect(readLink(withText({ kind: null }))).toBe('/read/d59f20aowb9c');
        expect(readLink(withText({ kind: 'collated', fullTextKey: 'wikisource-01' }))).toBe('/read/d59f20aowb9c');
    });

    it('readLink 与阅读页同一个 readerPath（Q7：地址只有一套拼法）', () => {
        const readLink = captured.props!.readLink as ReadLink;
        expect(readLink(withText())).toBe(readerPath('d59f20aowb9c'));
        expect(readLink(withText({ juan: '003' }))).toBe(readerPath('d59f20aowb9c', { chapter: '003' }));
    });

    it('readLink 带上 ctx.juan（回目网格的一回）：补成三位章号，直接打开那一章（B1）', () => {
        const readLink = captured.props!.readLink as ReadLink;
        expect(readLink(withText({ kind: 'fulltext', juan: '003' }))).toBe('/read/d59f20aowb9c/003');
        expect(readLink(withText({ juan: '第001' }))).toBe('/read/d59f20aowb9c/001');
        expect(readLink(withText({ juan: '12' }))).toBe('/read/d59f20aowb9c/012');
        // 没有数字的章名：退回第一章
        expect(readLink(withText({ juan: '序' }))).toBe('/read/d59f20aowb9c');
    });

    it('没有可读文本（没有 text_count、为 0）时不出「阅读全文」', () => {
        const readLink = captured.props!.readLink as ReadLink;
        expect(readLink({ kind: null })).toBeNull();
        expect(readLink({ detail: {} as never, kind: 'collated' })).toBeNull();
        expect(readLink({ detail: { text_count: 0 } as never })).toBeNull();
    });

    it('左栏顶部放站内检索框，回退表单 GET 到搜索页', () => {
        const box = screen.getByRole('searchbox', { name: '检索古籍索引' });
        expect(box.closest('form')).toHaveAttribute('action', '/book-index');
    });

    it('「数字化」照旧作为 extraTabs 传入', () => {
        const tabs = captured.props!.extraTabs as { key: string; label: string }[];
        expect(tabs.map((t) => [t.key, t.label])).toEqual([['digital', '数字化']]);
    });

    it('页内顶部不放繁简与 GitHub 图标：繁简在全站顶栏（9-30 反馈，overview#322）', () => {
        expect(captured.props!.hideHeaderControls).toBe(true);
    });
});

describe('BookDetailContent：服务端种子（overview#458 批次 0.1）', () => {
    beforeEach(() => { captured.props = undefined; mockGetEntry.mockClear(); });

    it('没传种子：不给 initialDetail，照旧客户端探测升格重定向（取一次条目）', () => {
        render(<BookDetailContent id="d59f20aowb9c" />);
        expect(captured.props!.initialDetail).toBeUndefined();
        expect(mockGetEntry).toHaveBeenCalledTimes(1);
    });

    it('传了种子：原样交给 BookDetailLayout，且不再为主条目发 getEntry', () => {
        render(<BookDetailContent id="d59f20aowb9c" initialDetail={{ id: 'd59f20aowb9c', type: 'work', title: '史記' }} />);
        expect(captured.props!.initialDetail).toMatchObject({ id: 'd59f20aowb9c', title: '史記' });
        expect(mockGetEntry).not.toHaveBeenCalled();
    });

    it('Entity 种子：primary_name 同步成 title，与 getItem 一致', () => {
        render(<BookDetailContent id="e1" initialDetail={{ id: 'e1', type: 'entity', primary_name: '司馬遷' }} />);
        expect((captured.props!.initialDetail as { title?: string }).title).toBe('司馬遷');
    });
});
