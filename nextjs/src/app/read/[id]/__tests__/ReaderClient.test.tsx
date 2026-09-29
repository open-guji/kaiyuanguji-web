/**
 * N5b：阅读页客户端部分——按 kind 挑组件、卷号与地址／<title>／canonical 双向同步、SSR 首帧与客户端一致。
 * 阅读器组件本身（book-index-ui）换成桩：这里只测路由这一半。
 */
import { act, render, screen, waitFor } from '@testing-library/react';
import { hydrateRoot } from 'react-dom/client';

const push = jest.fn();
// 地址栏当前的查询串；测试里改它再重渲染，模拟浏览器前进／后退
let searchParams = new URLSearchParams();
jest.mock('next/navigation', () => ({ useRouter: () => ({ push }), useSearchParams: () => searchParams }));
jest.mock('@/components/layout/LayoutWrapper', () => ({ children }: { children: React.ReactNode }) => <main>{children}</main>);
jest.mock('@/components/common/SourceContext', () => ({ useSource: () => ({ source: 'cos' }) }));

const getWorkFullTextList = jest.fn();
const getWorkFullTextChapter = jest.fn();
jest.mock('@/lib/transport', () => ({ getTransport: () => ({ getWorkFullTextList, getWorkFullTextChapter }) }));

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
import { seedCallKey, type ReaderSeed } from '../reader-seed';

const ZHIZHAI = 'd59f2htm01du'; // Work
const BOOK = '988fbiuha8'; // Book

function setCanonical(href: string) {
    document.head.innerHTML = `<link rel="canonical" href="${href}">`;
}

beforeEach(() => {
    searchParams = new URLSearchParams();
    jest.restoreAllMocks();
    document.body.innerHTML = ''; // 水合用例手工挂的容器
    last.collated = undefined;
    last.fulltext = undefined;
    getWorkFullTextList.mockReset();
    getWorkFullTextChapter.mockReset();
    push.mockClear();
});

describe('ReaderClient', () => {
    it('collated：渲染整理本，不传书影（resolveImages 不给，书影区自动收起），标题副题用组件默认', () => {
        window.history.replaceState(null, '', `/item/${ZHIZHAI}/read?kind=collated&juan=011`);
        // 地址与本页状态是短形式（011），传给组件的是它要的卷文件名
        render(<ReaderClient id={ZHIZHAI} initial={{ kind: 'collated', juan: '011' }} bookTitle="直齋書錄解題" />);
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
        expect(window.location.pathname + window.location.search).toBe(`/item/${ZHIZHAI}/read?kind=collated&juan=011`);
        expect(document.title).toBe('直齋書錄解題 · 卷11 · 整理本 - 开源古籍');
        expect(document.querySelector('link[rel=canonical]')!.getAttribute('href'))
            .toBe(`https://www.kaiyuanguji.com/item/${ZHIZHAI}/read?kind=collated&juan=011`);
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

    it('服务端给了首屏数据（WEB2）：不再取清单，首帧就是阅读器，目录作 index 传入，首章正文不发请求', async () => {
        const versions = [{ key: 'a', owner_type: 'Work' }, { key: 'b', owner_type: 'Work', primary: true }];
        const index = { chapters: [{ n: 1, title: '卷一', file: '001.md' }] };
        const seed = {
            workTexts: versions,
            key: 'b',
            fullTextIndex: index,
            calls: { [seedCallKey('getWorkFullTextChapter', ZHIZHAI, 'b', '001.md')]: '正文' },
        } as unknown as ReaderSeed;
        render(<ReaderClient id={ZHIZHAI} initial={{ kind: 'fulltext' }} bookTitle="t" seed={seed} />);
        expect(screen.queryByText('加载全文目录…')).toBeNull();
        expect(screen.getByTestId('fulltext')).toHaveTextContent('b|null');
        expect(last.fulltext!.index).toBe(index);
        expect(getWorkFullTextList).not.toHaveBeenCalled();
        const t = last.fulltext!.transport as { getWorkFullTextChapter: (...a: string[]) => Promise<unknown> };
        await expect(t.getWorkFullTextChapter(ZHIZHAI, 'b', '001.md')).resolves.toBe('正文');
        expect(getWorkFullTextChapter).not.toHaveBeenCalled();

        // 换到另一份：目录不是这一份的，不能再传 index
        act(() => { (last.fulltext!.onVersionChange as (k: string) => void)('a'); });
        expect(screen.getByTestId('fulltext')).toHaveTextContent('a|null');
        expect(last.fulltext!.index).toBeUndefined();
    });

    it('整理本：服务端给的卷目录作 index 传入', () => {
        const index = { juan_files: ['juan/011.json'] };
        render(<ReaderClient id={ZHIZHAI} initial={{ kind: 'collated' }} bookTitle="t" seed={{ collatedIndex: index } as unknown as ReaderSeed} />);
        expect(last.collated!.index).toBe(index);
    });

    it('整理本：目录里的卷文件名不是 juan/<短>.json 时，按目录换算回文件名', () => {
        const index = { juan_files: ['juan/序.json', 'juan/011.json'] };
        render(<ReaderClient id={ZHIZHAI} initial={{ kind: 'collated', juan: '序' }} bookTitle="t" seed={{ collatedIndex: index } as unknown as ReaderSeed} />);
        expect(last.collated!.activeJuan).toBe('juan/序.json');
    });

    it('SSR 首帧与客户端一致（带首屏数据的全文页也一样）', async () => {
        const seed = {
            workTexts: [{ key: 'b', owner_type: 'Work', primary: true }],
            key: 'b',
            fullTextIndex: { chapters: [{ n: 1, title: '卷一', file: '001.md' }] },
        } as unknown as ReaderSeed;
        const el = <ReaderClient id={ZHIZHAI} initial={{ kind: 'fulltext' }} bookTitle="t" seed={seed} />;
        const g = globalThis as { TextEncoder?: unknown; setImmediate?: unknown };
        g.TextEncoder ??= (await import('node:util')).TextEncoder;
        g.setImmediate ??= (fn: () => void) => setTimeout(fn, 0);
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { renderToString } = require('react-dom/server.node') as typeof import('react-dom/server');
        const html = renderToString(el);
        expect(html).toContain('b|null');
        const host = document.createElement('div');
        host.innerHTML = html;
        document.body.appendChild(host);
        const recoverable = jest.fn();
        await act(async () => { hydrateRoot(host, el, { onRecoverableError: recoverable }); });
        expect(recoverable).not.toHaveBeenCalled();
    });

    it('SSR 首帧与客户端一致（水合不报不一致）', async () => {
        const el = <ReaderClient id={ZHIZHAI} initial={{ kind: 'collated', juan: '011' }} bookTitle="直齋書錄解題" />;
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

/** overview#267 P2-3：翻卷、换版本留历史，浏览器返回回到上一卷；阅读器自己补第一卷、首帧只 replace */
describe('ReaderClient：历史记录', () => {
    it('翻一卷 pushState 一次；首帧与阅读器补第一卷只 replaceState', () => {
        window.history.replaceState(null, '', `/item/${BOOK}/read?kind=fulltext`);
        const pushState = jest.spyOn(window.history, 'pushState');
        const replaceState = jest.spyOn(window.history, 'replaceState');
        render(<ReaderClient id={BOOK} initial={{ kind: 'fulltext' }} bookTitle="紅樓夢" />);
        expect(pushState).not.toHaveBeenCalled();

        // 地址没带卷号，组件回报第一卷：不是读者翻的，与当前这条合并
        act(() => { (last.fulltext!.onChapterChange as Cb)('001'); });
        expect(pushState).not.toHaveBeenCalled();
        expect(replaceState).toHaveBeenCalledWith(null, '', `/item/${BOOK}/read?kind=fulltext&juan=001`);

        // 读者翻到下一回：新增一条历史
        act(() => { (last.fulltext!.onChapterChange as Cb)('002'); });
        expect(pushState).toHaveBeenCalledTimes(1);
        expect(pushState).toHaveBeenLastCalledWith(null, '', `/item/${BOOK}/read?kind=fulltext&juan=002`);
        act(() => { (last.fulltext!.onChapterChange as Cb)('003'); });
        expect(pushState).toHaveBeenCalledTimes(2);
        // 再回报同一卷不重复推
        act(() => { (last.fulltext!.onChapterChange as Cb)('003'); });
        expect(pushState).toHaveBeenCalledTimes(2);
    });

    it('浏览器返回（地址变了）：状态与阅读器跟着回到上一卷，且不再多推一条', () => {
        window.history.replaceState(null, '', `/item/${BOOK}/read?kind=fulltext&juan=003`);
        searchParams = new URLSearchParams('kind=fulltext&juan=003');
        const { rerender } = render(<ReaderClient id={BOOK} initial={{ kind: 'fulltext', juan: '003' }} bookTitle="t" />);
        act(() => { (last.fulltext!.onChapterChange as Cb)('004'); });
        expect(window.location.search).toBe('?kind=fulltext&juan=004');
        expect(screen.getByTestId('fulltext')).toHaveTextContent('|004');
        // Next 会把 pushState 同步进 useSearchParams
        searchParams = new URLSearchParams('kind=fulltext&juan=004');
        rerender(<ReaderClient id={BOOK} initial={{ kind: 'fulltext', juan: '003' }} bookTitle="t" />);
        expect(screen.getByTestId('fulltext')).toHaveTextContent('|004');

        // 模拟返回：地址栏回到第三回，Next 的 useSearchParams 随之变化
        const pushState = jest.spyOn(window.history, 'pushState');
        window.history.replaceState(null, '', `/item/${BOOK}/read?kind=fulltext&juan=003`);
        searchParams = new URLSearchParams('kind=fulltext&juan=003');
        rerender(<ReaderClient id={BOOK} initial={{ kind: 'fulltext', juan: '003' }} bookTitle="t" />);
        expect(screen.getByTestId('fulltext')).toHaveTextContent('|003');
        expect(window.location.search).toBe('?kind=fulltext&juan=003');
        expect(pushState).not.toHaveBeenCalled();
    });

    it('Work 换版本也留一条历史', async () => {
        getWorkFullTextList.mockResolvedValue([
            { key: 'a', owner_type: 'Work' },
            { key: 'b', owner_type: 'Work', primary: true },
        ]);
        window.history.replaceState(null, '', `/item/${ZHIZHAI}/read?kind=fulltext&key=a&juan=003`);
        const pushState = jest.spyOn(window.history, 'pushState');
        render(<ReaderClient id={ZHIZHAI} initial={{ kind: 'fulltext', key: 'a', juan: '003' }} bookTitle="t" />);
        await waitFor(() => expect(screen.getByTestId('fulltext')).toHaveTextContent('a|003'));
        act(() => { (last.fulltext!.onVersionChange as (k: string) => void)('b'); });
        expect(pushState).toHaveBeenCalledTimes(1);
        expect(window.location.search).toBe('?kind=fulltext&key=b');
    });
});

/** overview#267 P3：以「回」分章的书，title 用目录里的章名 */
describe('ReaderClient：<title> 用章名', () => {
    it('服务端给了目录：首帧与翻卷后都写章名，没有章名的卷回落「卷N」', () => {
        const seed = {
            fullTextIndex: { chapters: [
                { n: 3, title: '第三回', file: '003.md' },
                { n: 4, title: '第四回', file: '004.md' },
                { n: 5, title: '', file: '005.md' },
            ] },
        } as unknown as ReaderSeed;
        window.history.replaceState(null, '', `/item/${BOOK}/read?kind=fulltext&juan=003`);
        render(<ReaderClient id={BOOK} initial={{ kind: 'fulltext', juan: '003' }} bookTitle="紅樓夢" seed={seed} />);
        expect(document.title).toBe('紅樓夢 · 第三回 · 全文 - 开源古籍');
        act(() => { (last.fulltext!.onChapterChange as Cb)('004'); });
        expect(document.title).toBe('紅樓夢 · 第四回 · 全文 - 开源古籍');
        act(() => { (last.fulltext!.onChapterChange as Cb)('005'); });
        expect(document.title).toBe('紅樓夢 · 卷5 · 全文 - 开源古籍');
    });

    it('服务端没给目录：浏览器取目录后补上章名', async () => {
        const getBookFullTextIndex = jest.fn().mockResolvedValue({ chapters: [{ n: 3, title: '第三回', file: '003.md' }] });
        const tr = jest.requireMock('@/lib/transport') as { getTransport: () => unknown };
        jest.spyOn(tr, 'getTransport').mockReturnValue({ getBookFullTextIndex });
        window.history.replaceState(null, '', `/item/${BOOK}/read?kind=fulltext&juan=003`);
        render(<ReaderClient id={BOOK} initial={{ kind: 'fulltext', juan: '003' }} bookTitle="紅樓夢" />);
        await waitFor(() => expect(document.title).toBe('紅樓夢 · 第三回 · 全文 - 开源古籍'));
        expect(getBookFullTextIndex).toHaveBeenCalledWith(BOOK);
    });
});
