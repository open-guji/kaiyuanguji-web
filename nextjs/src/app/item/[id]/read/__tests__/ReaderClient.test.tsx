/**
 * N5b：阅读页客户端部分——按 kind 挑组件、卷号与地址／<title>／canonical 双向同步、SSR 首帧与客户端一致。
 * 阅读器组件本身（book-index-ui）换成桩：这里只测路由这一半。
 */
import { act, render, screen, waitFor } from '@testing-library/react';
import { hydrateRoot } from 'react-dom/client';

const push = jest.fn();
jest.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));
jest.mock('@/components/layout/LayoutWrapper', () => ({ children }: { children: React.ReactNode }) => <main>{children}</main>);
jest.mock('@/components/common/SourceContext', () => ({ useSource: () => ({ source: 'cos' }) }));

const getWorkFullTextList = jest.fn();
jest.mock('@/lib/transport', () => ({ getTransport: () => ({ getWorkFullTextList }) }));

type Cb = (v: string | null) => void;
const last: { collated?: Record<string, unknown>; fulltext?: Record<string, unknown> } = {};
jest.mock('book-index-ui', () => ({
    LocaleProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    CollatedEdition: (p: Record<string, unknown>) => {
        last.collated = p;
        return <div data-testid="collated">{String(p.activeJuan)}</div>;
    },
    BookFullText: (p: Record<string, unknown>) => {
        last.fulltext = p;
        return <div data-testid="fulltext">{`${String(p.workKey ?? '')}|${String(p.activeChapter)}`}</div>;
    },
}));

import ReaderClient from '../ReaderClient';

const ZHIZHAI = 'd59f2htm01du'; // Work
const BOOK = '988fbiuha8'; // Book

function setCanonical(href: string) {
    document.head.innerHTML = `<link rel="canonical" href="${href}">`;
}

beforeEach(() => {
    last.collated = undefined;
    last.fulltext = undefined;
    getWorkFullTextList.mockReset();
    push.mockClear();
});

describe('ReaderClient', () => {
    it('collated：渲染整理本，不传书影（resolveImages 不给，书影区自动收起），标题副题用组件默认', () => {
        window.history.replaceState(null, '', `/item/${ZHIZHAI}/read?kind=collated&juan=juan%2F011.json`);
        render(<ReaderClient id={ZHIZHAI} initial={{ kind: 'collated', juan: 'juan/011.json' }} bookTitle="直齋書錄解題" />);
        expect(screen.getByTestId('collated')).toHaveTextContent('juan/011.json');
        expect(last.collated).toMatchObject({ workId: ZHIZHAI, activeJuan: 'juan/011.json' });
        expect(last.collated).not.toHaveProperty('resolveImages');
        expect(last.collated).not.toHaveProperty('title');
        expect(last.collated).not.toHaveProperty('subtitle');
    });

    it('翻卷：地址、<title>、canonical 跟着改，不整页刷新', () => {
        setCanonical(`https://www.kaiyuanguji.com/item/${ZHIZHAI}/read?kind=collated`);
        window.history.replaceState(null, '', `/item/${ZHIZHAI}/read?kind=collated`);
        render(<ReaderClient id={ZHIZHAI} initial={{ kind: 'collated' }} bookTitle="直齋書錄解題" />);
        act(() => { (last.collated!.onJuanChange as Cb)('juan/011.json'); });
        expect(window.location.pathname + window.location.search).toBe(`/item/${ZHIZHAI}/read?kind=collated&juan=juan%2F011.json`);
        expect(document.title).toBe('直齋書錄解題 · 卷11 · 整理本 - 开源古籍');
        expect(document.querySelector('link[rel=canonical]')!.getAttribute('href'))
            .toBe(`https://www.kaiyuanguji.com/item/${ZHIZHAI}/read?kind=collated&juan=juan%2F011.json`);
        expect(screen.getByTestId('collated')).toHaveTextContent('juan/011.json');
        expect(push).not.toHaveBeenCalled();
    });

    it('Book 全文：直接渲染，卷号同步', () => {
        render(<ReaderClient id={BOOK} initial={{ kind: 'fulltext', juan: '001' }} bookTitle="御定佩文韻府" />);
        expect(screen.getByTestId('fulltext')).toHaveTextContent('|001');
        expect(getWorkFullTextList).not.toHaveBeenCalled();
        act(() => { (last.fulltext!.onChapterChange as Cb)('002'); });
        expect(window.location.search).toBe('?kind=fulltext&juan=002');
    });

    it('Work 全文：没带 key 取首选那份；地址里的 key 对得上就用它；换版本清卷号', async () => {
        getWorkFullTextList.mockResolvedValue([
            { key: 'a', owner_type: 'Work' },
            { key: 'b', owner_type: 'Work', primary: true },
            { key: 'c', owner_type: 'Book' },
        ]);
        const { unmount } = render(<ReaderClient id={ZHIZHAI} initial={{ kind: 'fulltext' }} bookTitle="t" />);
        expect(screen.getByText('加载全文目录…')).toBeInTheDocument();
        await waitFor(() => expect(screen.getByTestId('fulltext')).toHaveTextContent('b|null'));
        expect((last.fulltext!.versions as unknown[]).length).toBe(2);
        unmount();

        render(<ReaderClient id={ZHIZHAI} initial={{ kind: 'fulltext', key: 'a', juan: '003' }} bookTitle="t" />);
        await waitFor(() => expect(screen.getByTestId('fulltext')).toHaveTextContent('a|003'));
        act(() => { (last.fulltext!.onVersionChange as (k: string) => void)('b'); });
        expect(screen.getByTestId('fulltext')).toHaveTextContent('b|null');
        expect(window.location.search).toBe('?kind=fulltext&key=b');
    });

    it('SSR 首帧与客户端一致（水合不报不一致）', async () => {
        const el = <ReaderClient id={ZHIZHAI} initial={{ kind: 'collated', juan: 'juan/011.json' }} bookTitle="直齋書錄解題" />;
        // 用 Node 版的服务端渲染（浏览器版要 MessageChannel，jsdom 没有）；它要的 TextEncoder／setImmediate 补上
        const g = globalThis as { TextEncoder?: unknown; setImmediate?: unknown };
        g.TextEncoder ??= (await import('node:util')).TextEncoder;
        g.setImmediate ??= (fn: () => void) => setTimeout(fn, 0);
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { renderToString } = require('react-dom/server.node') as typeof import('react-dom/server');
        const html = renderToString(el);
        const host = document.createElement('div');
        host.innerHTML = html;
        document.body.appendChild(host);
        const errors = jest.spyOn(console, 'error').mockImplementation(() => {});
        const recoverable = jest.fn();
        await act(async () => { hydrateRoot(host, el, { onRecoverableError: recoverable }); });
        expect(recoverable).not.toHaveBeenCalled();
        expect(errors).not.toHaveBeenCalled();
        errors.mockRestore();
        expect(host.innerHTML).toBe(html);
    });
});
