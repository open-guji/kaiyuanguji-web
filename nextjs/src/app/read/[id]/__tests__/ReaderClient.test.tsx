/**
 * overview#307 E 块：阅读页客户端部分——把版本与章交给统一阅读器（TextReader，受控），
 * 位置变化同步地址／<title>／canonical、浏览器前进后退跟着地址、SSR 首帧与客户端一致。
 * 阅读器组件本身（book-index-ui）换成桩：这里只测路由这一半。
 */
import { act, render, screen } from '@testing-library/react';
import { hydrateRoot } from 'react-dom/client';

const push = jest.fn();
// 地址栏当前的路径；测试里改它再重渲染，模拟浏览器前进／后退
let pathname = '/read/d59f2htm01du';
jest.mock('next/navigation', () => ({ useRouter: () => ({ push }), usePathname: () => pathname }));
jest.mock('@/components/layout/LayoutWrapper', () => ({ children }: { children: React.ReactNode }) => <main>{children}</main>);
jest.mock('@/components/common/SourceContext', () => ({ useSource: () => ({ source: 'cos' }) }));
// 全站繁简偏好：阅读页要包在跟全站走的 BimLocaleProvider 里（overview#322），这里用带标记的桩
jest.mock('@/components/common/BimLocaleProvider', () => ({ children }: { children: React.ReactNode }) => <div data-testid="bim-locale">{children}</div>);

const mockGetJson = jest.fn();
const mockProofIndex = jest.fn(async (): Promise<unknown> => null);
jest.mock('@/lib/proofing', () => ({ ...jest.requireActual('@/lib/proofing'), loadProofIndex: () => mockProofIndex() }));
jest.mock('@/lib/duidu-data', () => ({ ...jest.requireActual('@/lib/duidu-data'), getJson: (...a: unknown[]) => mockGetJson(...a) }));

const getTextManifest = jest.fn();
const getTextIndex = jest.fn();
jest.mock('@/lib/transport', () => ({ getTransport: () => ({ getTextManifest, getTextIndex, getChapter: jest.fn() }) }));

const last: { reader?: Record<string, unknown> } = {};
// 对读数据适配：记下第三参数（norm）；pages 非空才不会被当成「没有对读」
const mockAdaptCharCord = jest.fn((..._a: unknown[]) => [{ page: 3 }]);
jest.mock('book-index-ui', () => ({
    adaptCharCord: (...a: unknown[]) => mockAdaptCharCord(...a),
    adaptPunctJson: () => [],
    iiifVolumeOf: () => null,
    LocaleProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    // 反馈标签里的书名、版本名经 useConvert 转（不在 LocaleProvider 里时原样）
    useConvert: () => ({ convert: (s: string) => s }),
    TextReader: (p: Record<string, unknown>) => {
        last.reader = p;
        return <div data-testid="reader">{`${String(p.versionKey)}|${String(p.chapter)}`}</div>;
    },
    createTextApi: (t: { getTextManifest: (id: string) => Promise<unknown>; getTextIndex: (id: string, k: string) => Promise<unknown> }) => ({
        getManifest: (id: string) => t.getTextManifest(id),
        getIndex: (id: string, k: string) => t.getTextIndex(id, k),
    }),
}));

import ReaderClient, { anchorFromHash } from '../ReaderClient';
import { seedCallKey, type ReaderSeed } from '../reader-seed';

const ZHIZHAI = 'd59f2htm01du'; // Work
const BOOK = '988fbiuha8'; // Book

type Loc = { key: string; chapter: string | null; isDefault: boolean; anchor?: string };
type OnLoc = (l: Loc, cause: 'auto' | 'chapter' | 'version') => void;

const MANIFEST = {
    id: ZHIZHAI,
    versions: [
        // default 取全文型：目录型 default 的过滤另有用例（overview#456）
        { key: 'default', kind: 'transcription', label: '整理本' },
        { key: 'wikisource', kind: 'transcription', label: '維基文庫' },
    ],
};
const INDEXES: Record<string, unknown> = {
    default: { chapters: [{ n: 3, file: '003', title: '第三回' }, { n: 4, file: '004', title: '第四回' }, { n: 5, file: '005', title: '' }] },
    wikisource: { chapters: [{ n: 3, file: '003', title: '卷三' }] },
};

function setCanonical(href: string) {
    document.head.innerHTML = `<link rel="canonical" href="${href}">`;
}
const at = () => window.location.pathname;

beforeEach(() => {
    pathname = `/read/${ZHIZHAI}`;
    jest.restoreAllMocks();
    document.body.innerHTML = '';
    document.head.innerHTML = '';
    last.reader = undefined;
    push.mockClear();
    getTextManifest.mockReset().mockResolvedValue(MANIFEST);
    getTextIndex.mockReset().mockImplementation(async (_id: string, key: string) => INDEXES[key]);
    window.history.replaceState(null, '', `/read/${ZHIZHAI}`);
});

describe('ReaderClient', () => {
    it('阅读器包在跟全站繁简走的 BimLocaleProvider 里（顶栏切繁简时阅读页跟着变）', () => {
        render(<ReaderClient id={ZHIZHAI} initial={{ chapter: '003' }} bookTitle="直齋書錄解題" />);
        expect(screen.getByTestId('bim-locale')).toContainElement(screen.getByTestId('reader'));
    });

    it('把版本与章受控地交给阅读器：主版本 key 写 default，书名作工具条书名，带「报告错字」与条目跳转', async () => {
        render(<ReaderClient id={ZHIZHAI} initial={{ chapter: '003' }} bookTitle="直齋書錄解題" />);
        expect(screen.getByTestId('reader')).toHaveTextContent('default|003');
        expect(last.reader).toMatchObject({ id: ZHIZHAI, versionKey: 'default', chapter: '003', title: '直齋書錄解題', backHref: '/read' });
        expect(typeof last.reader!.onLocationChange).toBe('function');
        expect(typeof last.reader!.onReportError).toBe('function');
        (last.reader!.onNavigate as (id: string) => void)('d59f2aaaaaaa');
        expect(push).toHaveBeenCalledWith('/item/d59f2aaaaaaa');
        await act(async () => { await Promise.resolve(); });
    });

    it('其他版本：versionKey 就是 key；没有章号交 null（阅读器选第一章并以 auto 通知）', async () => {
        render(<ReaderClient id={ZHIZHAI} initial={{ key: 'wikisource' }} bookTitle="t" />);
        expect(screen.getByTestId('reader')).toHaveTextContent('wikisource|null');
        await act(async () => { await Promise.resolve(); });
    });

    it('没有种子、目录型 default 被隐藏：阅读器先按 default 挂载再以 auto 回到主版本，地址里的章号保留（overview#456）', async () => {
        let resolve!: (m: unknown) => void;
        getTextManifest.mockReset().mockReturnValue(new Promise((r) => { resolve = r; }));
        window.history.replaceState(null, '', `/read/${ZHIZHAI}/004`);
        render(<ReaderClient id={ZHIZHAI} initial={{ chapter: '004' }} bookTitle="t" />);
        expect(screen.getByTestId('reader')).toHaveTextContent('default|004');
        // 阅读器的 manifest 先回来（目录型 default 已被隐藏，主版本是 wikisource），以 auto 通知回到主版本第一章
        await act(async () => { (last.reader!.onLocationChange as OnLoc)({ key: 'wikisource', chapter: null, isDefault: true }, 'auto'); });
        expect(screen.getByTestId('reader')).toHaveTextContent('wikisource|004'); // 版本 key 改成主版本，章号不动
        expect(at()).toBe(`/read/${ZHIZHAI}/004`);
        // 我们自己的 manifest 请求随后回来，不再改动
        await act(async () => { resolve({ id: ZHIZHAI, versions: [{ key: 'wikisource', kind: 'transcription' }] }); });
        expect(screen.getByTestId('reader')).toHaveTextContent('wikisource|004');
        expect(at()).toBe(`/read/${ZHIZHAI}/004`);
    });

    it('翻章：地址、<title>（书名 · 章名 · 版本名）、canonical 跟着改，不整页刷新', async () => {
        setCanonical(`https://www.kaiyuanguji.com/read/${ZHIZHAI}/003`);
        window.history.replaceState(null, '', `/read/${ZHIZHAI}/003`);
        render(<ReaderClient id={ZHIZHAI} initial={{ chapter: '003' }} bookTitle="直齋書錄解題" />);
        await act(async () => { await Promise.resolve(); await Promise.resolve(); });
        expect(document.title).toBe('直齋書錄解題 · 第三回 - 开源古籍');

        await act(async () => { (last.reader!.onLocationChange as OnLoc)({ key: 'default', chapter: '004', isDefault: true }, 'chapter'); });
        expect(at()).toBe(`/read/${ZHIZHAI}/004`);
        expect(document.title).toBe('直齋書錄解題 · 第四回 - 开源古籍');
        expect(document.querySelector('link[rel=canonical]')!.getAttribute('href')).toBe(`https://www.kaiyuanguji.com/read/${ZHIZHAI}/004`);
        expect(screen.getByTestId('reader')).toHaveTextContent('default|004');
        expect(push).not.toHaveBeenCalled();

        // 没有章名的章回落「卷N」
        await act(async () => { (last.reader!.onLocationChange as OnLoc)({ key: 'default', chapter: '005', isDefault: true }, 'chapter'); });
        expect(document.title).toBe('直齋書錄解題 · 卷5 - 开源古籍');
    });

    it('切版本：地址换成 /<key>/<章>，title 里的版本名跟着变；切回主版本地址里不带 key', async () => {
        render(<ReaderClient id={ZHIZHAI} initial={{ chapter: '003' }} bookTitle="t" />);
        await act(async () => { (last.reader!.onLocationChange as OnLoc)({ key: 'wikisource', chapter: '003', isDefault: false }, 'version'); });
        expect(at()).toBe(`/read/${ZHIZHAI}/wikisource/003`);
        expect(screen.getByTestId('reader')).toHaveTextContent('wikisource|003');
        expect(document.title).toBe('t · 卷三 · 維基文庫 - 开源古籍');
        await act(async () => { (last.reader!.onLocationChange as OnLoc)({ key: 'default', chapter: '003', isDefault: true }, 'version'); });
        expect(at()).toBe(`/read/${ZHIZHAI}/003`);
        expect(screen.getByTestId('reader')).toHaveTextContent('default|003');
    });

    it('服务端给了首屏数据（WEB2）：阅读器拿到的 transport 就地返回 manifest，不再发请求', async () => {
        const seed = { calls: { [seedCallKey('getTextManifest', ZHIZHAI)]: MANIFEST } } as ReaderSeed;
        render(<ReaderClient id={ZHIZHAI} initial={{ chapter: '003' }} bookTitle="t" seed={seed} />);
        const t = last.reader!.transport as { getTextManifest: (id: string) => Promise<unknown> };
        await expect(t.getTextManifest(ZHIZHAI)).resolves.toBe(MANIFEST);
        expect(getTextManifest).not.toHaveBeenCalled();
        await act(async () => { await Promise.resolve(); });
    });

    it('SSR 首帧与客户端一致（水合不报不一致）', async () => {
        const el = <ReaderClient id={ZHIZHAI} initial={{ key: 'wikisource', chapter: '003' }} bookTitle="直齋書錄解題" />;
        // 用 Node 版的服务端渲染（浏览器版要 MessageChannel，jsdom 没有）；它要的 TextEncoder／setImmediate 补上
        const g = globalThis as { TextEncoder?: unknown; setImmediate?: unknown };
        g.TextEncoder ??= (await import('node:util')).TextEncoder;
        g.setImmediate ??= (fn: () => void) => setTimeout(fn, 0);
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { renderToString } = require('react-dom/server.node') as typeof import('react-dom/server');
        const html = renderToString(el);
        expect(html).toContain('wikisource|003');
        const host = document.createElement('div');
        host.innerHTML = html;
        document.body.appendChild(host);
        const errors = jest.spyOn(console, 'error').mockImplementation(() => {});
        const recoverable = jest.fn();
        await act(async () => { hydrateRoot(host, el, { onRecoverableError: recoverable }); });
        expect(recoverable).not.toHaveBeenCalled();
        expect(errors).not.toHaveBeenCalled();
        errors.mockRestore();
    });
});

/** overview#267 P2-3：翻章、换版本留历史，浏览器返回回到上一章；阅读器自己纠正位置、首帧只 replace */
describe('ReaderClient：历史记录', () => {
    it('读者翻一章 pushState 一次；首帧与阅读器自己纠正位置（auto）只 replaceState', async () => {
        window.history.replaceState(null, '', `/read/${BOOK}`);
        pathname = `/read/${BOOK}`;
        const pushState = jest.spyOn(window.history, 'pushState');
        const replaceState = jest.spyOn(window.history, 'replaceState');
        render(<ReaderClient id={BOOK} initial={{}} bookTitle="紅樓夢" />);
        await act(async () => { await Promise.resolve(); });
        expect(pushState).not.toHaveBeenCalled();

        // 地址没带章号，阅读器回落第一章并以 auto 通知：不是读者翻的，与当前这条合并
        await act(async () => { (last.reader!.onLocationChange as OnLoc)({ key: 'default', chapter: '001', isDefault: true }, 'auto'); });
        expect(pushState).not.toHaveBeenCalled();
        expect(replaceState).toHaveBeenCalledWith(null, '', `/read/${BOOK}/001`);

        // 读者翻到下一回：新增一条历史
        await act(async () => { (last.reader!.onLocationChange as OnLoc)({ key: 'default', chapter: '002', isDefault: true }, 'chapter'); });
        expect(pushState).toHaveBeenCalledTimes(1);
        expect(pushState).toHaveBeenLastCalledWith(null, '', `/read/${BOOK}/002`);
        await act(async () => { (last.reader!.onLocationChange as OnLoc)({ key: 'default', chapter: '003', isDefault: true }, 'chapter'); });
        expect(pushState).toHaveBeenCalledTimes(2);
        // 再回报同一章不重复推
        await act(async () => { (last.reader!.onLocationChange as OnLoc)({ key: 'default', chapter: '003', isDefault: true }, 'chapter'); });
        expect(pushState).toHaveBeenCalledTimes(2);
    });

    it('章内标题（GUJI-240）：地址 #页:列:格 交给阅读器；点目录标题时地址带上它，换章去掉', async () => {
        window.history.replaceState(null, '', `/read/${BOOK}/002#39:1:1`);
        pathname = `/read/${BOOK}/002`;
        const pushState = jest.spyOn(window.history, 'pushState');
        render(<ReaderClient id={BOOK} initial={{ chapter: '002' }} bookTitle="t" />);
        await act(async () => { await Promise.resolve(); });
        expect(last.reader!.anchor).toBe('39:1:1');
        expect(window.location.hash).toBe('#39:1:1');   // 首帧不把 hash 冲掉
        expect(pushState).not.toHaveBeenCalled();

        // 目录点了本册另一个标题：同一章，地址换 hash，留一条历史
        await act(async () => { (last.reader!.onLocationChange as OnLoc)({ key: 'default', chapter: '002', isDefault: true, anchor: '77:1:1' }, 'chapter'); });
        expect(pushState).toHaveBeenLastCalledWith(null, '', `/read/${BOOK}/002#77:1:1`);

        // 换章（不带标题）：hash 去掉
        await act(async () => { (last.reader!.onLocationChange as OnLoc)({ key: 'default', chapter: '003', isDefault: true }, 'chapter'); });
        expect(window.location.pathname + window.location.hash).toBe(`/read/${BOOK}/003`);

        // 读者手改地址的 hash：阅读器跟着滚过去
        await act(async () => {
            window.history.replaceState(null, '', `/read/${BOOK}/003#3:3:2`);
            window.dispatchEvent(new HashChangeEvent('hashchange'));
        });
        expect(last.reader!.anchor).toBe('3:3:2');
    });

    it('anchorFromHash：只认格位', () => {
        expect(anchorFromHash('#39:4:18b')).toBe('39:4:18b');
        expect(anchorFromHash('#3:1:-1')).toBe('3:1:-1');
        expect(anchorFromHash('#39%3A1%3A1')).toBe('39:1:1');
        expect(anchorFromHash('')).toBeNull();
        expect(anchorFromHash('#top')).toBeNull();
        expect(anchorFromHash('#%E0%A4%A')).toBeNull();
    });

    it('浏览器返回（地址变了）：状态与阅读器跟着回到上一章，且不再多推一条', async () => {
        window.history.replaceState(null, '', `/read/${BOOK}/003`);
        pathname = `/read/${BOOK}/003`;
        const { rerender } = render(<ReaderClient id={BOOK} initial={{ chapter: '003' }} bookTitle="t" />);
        await act(async () => { (last.reader!.onLocationChange as OnLoc)({ key: 'default', chapter: '004', isDefault: true }, 'chapter'); });
        expect(at()).toBe(`/read/${BOOK}/004`);
        expect(screen.getByTestId('reader')).toHaveTextContent('default|004');
        // Next 会把 pushState 同步进 usePathname
        pathname = `/read/${BOOK}/004`;
        rerender(<ReaderClient id={BOOK} initial={{ chapter: '003' }} bookTitle="t" />);
        expect(screen.getByTestId('reader')).toHaveTextContent('default|004');

        // 模拟返回：地址栏回到第三章，Next 的 usePathname 随之变化
        const pushState = jest.spyOn(window.history, 'pushState');
        window.history.replaceState(null, '', `/read/${BOOK}/003`);
        pathname = `/read/${BOOK}/003`;
        rerender(<ReaderClient id={BOOK} initial={{ chapter: '003' }} bookTitle="t" />);
        await act(async () => { await Promise.resolve(); });
        expect(screen.getByTestId('reader')).toHaveTextContent('default|003');
        expect(at()).toBe(`/read/${BOOK}/003`);
        expect(pushState).not.toHaveBeenCalled();
    });

    it('返回到另一个版本的地址：版本也跟着回去', async () => {
        window.history.replaceState(null, '', `/read/${ZHIZHAI}/003`);
        pathname = `/read/${ZHIZHAI}/003`;
        const { rerender } = render(<ReaderClient id={ZHIZHAI} initial={{ chapter: '003' }} bookTitle="t" />);
        await act(async () => { (last.reader!.onLocationChange as OnLoc)({ key: 'wikisource', chapter: '003', isDefault: false }, 'version'); });
        pathname = `/read/${ZHIZHAI}/wikisource/003`;
        rerender(<ReaderClient id={ZHIZHAI} initial={{ chapter: '003' }} bookTitle="t" />);
        window.history.replaceState(null, '', `/read/${ZHIZHAI}/003`);
        pathname = `/read/${ZHIZHAI}/003`;
        rerender(<ReaderClient id={ZHIZHAI} initial={{ chapter: '003' }} bookTitle="t" />);
        await act(async () => { await Promise.resolve(); });
        expect(screen.getByTestId('reader')).toHaveTextContent('default|003');
    });

    it('地址变成别的条目或不合法的地址：不动', async () => {
        render(<ReaderClient id={ZHIZHAI} initial={{ chapter: '003' }} bookTitle="t" />);
        const { rerender } = render(<ReaderClient id={ZHIZHAI} initial={{ chapter: '003' }} bookTitle="t" />);
        pathname = '/item/d59f2htm01du';
        rerender(<ReaderClient id={ZHIZHAI} initial={{ chapter: '003' }} bookTitle="t" />);
        pathname = `/read/${ZHIZHAI}/a/b/c`;
        rerender(<ReaderClient id={ZHIZHAI} initial={{ chapter: '003' }} bookTitle="t" />);
        await act(async () => { await Promise.resolve(); });
        expect(screen.getAllByTestId('reader')[0]).toHaveTextContent('default|003');
    });

    // overview#540：norm（规范层）读
    describe('resolveWarpData：norm_file', () => {
        type ResolveWarp = (key: string, ctx: unknown) => Promise<Record<string, unknown> | null>;
        const CHAR = { file: '003', char_file: '003.char.json', cord_file: '003.cord.json' };
        const run = async (id: string, chapter: Record<string, unknown>) => {
            global.fetch = jest.fn(async (url: string) => ({ ok: true, json: async () => ({ url }) })) as unknown as typeof fetch;
            render(<ReaderClient id={id} initial={{ chapter: '003' }} bookTitle="t" />);
            await act(async () => { await Promise.resolve(); });
            return (last.reader!.resolveWarpData as ResolveWarp)('003', { versionKey: 'original', chapter });
        };
        beforeEach(() => { mockAdaptCharCord.mockClear(); });

        it('章条目声明了 norm_file：取回的 norm 作为 adaptCharCord 的第三参数，数据带 hasNorm=true', async () => {
            const r = await run('book-nm1', { ...CHAR, norm_file: '003.norm.json' });
            expect(mockAdaptCharCord).toHaveBeenCalledTimes(1);
            const [char, cord, norm] = mockAdaptCharCord.mock.calls[0];
            expect(char).toEqual({ url: '/data/items/book-nm1/original/003.char.json' });
            expect(cord).toEqual({ url: '/data/items/book-nm1/original/003.cord.json' });
            expect(norm).toEqual({ url: '/data/items/book-nm1/original/003.norm.json' });
            expect(r?.hasNorm).toBe(true);
        });

        it('没声明 norm_file（外来文本）：第三参数为 null，hasNorm=false——阅读器的「原字」档据此置灰', async () => {
            const r = await run('book-nm2', CHAR);
            expect(mockAdaptCharCord.mock.calls[0][2]).toBeNull();
            expect(r?.hasNorm).toBe(false);
        });
    });

});

describe('本章校对提示', () => {
    const proofIndex = { chapters: [{ n: 1, file: '001', title: '卷首', proofing: true, pending_file: '001.pending.json' }] };
    const show = async () => {
        getTextIndex.mockReset().mockResolvedValue(proofIndex);
        render(<ReaderClient id={ZHIZHAI} initial={{ chapter: '001' }} bookTitle="t" />);
        await act(async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); });
    };
    beforeEach(() => { sessionStorage.clear(); mockGetJson.mockReset(); mockProofIndex.mockReset().mockResolvedValue(null); });

    it('还有待审的字：显示提示', async () => {
        mockGetJson.mockResolvedValue({ rev: 'r1', cells: [{ a: '9:1:1' }] });
        await show();
        expect(screen.getByTestId('proofing-notice')).toBeTruthy();
        expect(mockGetJson).toHaveBeenCalledWith(expect.anything(), ZHIZHAI, 'default', '001.pending.json');
    });
    it('待审单已清空：不再请读者去校对', async () => {
        mockGetJson.mockResolvedValue({ rev: 'r1', cells: [] });
        await show();
        expect(screen.queryByTestId('proofing-notice')).toBeNull();
    });
    it('待审单取不到：照旧显示', async () => {
        mockGetJson.mockRejectedValue(new Error('net'));
        await show();
        expect(screen.getByTestId('proofing-notice')).toBeTruthy();
    });
});

describe('本章校对提示：COS 总表优先', () => {
    const plainIndex = { chapters: [{ n: 1, file: '001', title: '卷首' }] };
    const flagged = { chapters: [{ n: 1, file: '001', title: '卷首', proofing: true, pending_file: '001.pending.json' }] };
    const show = async (index: unknown) => {
        getTextIndex.mockReset().mockResolvedValue(index);
        render(<ReaderClient id={ZHIZHAI} initial={{ chapter: '001' }} bookTitle="t" />);
        await act(async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); });
    };
    beforeEach(() => { sessionStorage.clear(); mockGetJson.mockReset().mockResolvedValue({ rev: 'r', cells: [{ a: '1:1:1' }] }); });

    it('总表说这章还有待审：没有 proofing 标记也显示', async () => {
        mockProofIndex.mockReset().mockResolvedValue({ [ZHIZHAI]: { '001': { rev: 'r', n: 3 } } });
        await show(plainIndex);
        expect(screen.getByTestId('proofing-notice')).toBeTruthy();
        expect(mockGetJson).not.toHaveBeenCalled();
    });
    it('总表说这章 0 格：有 proofing 标记也不显示', async () => {
        mockProofIndex.mockReset().mockResolvedValue({ [ZHIZHAI]: { '001': { rev: 'r', n: 0 } } });
        await show(flagged);
        expect(screen.queryByTestId('proofing-notice')).toBeNull();
    });
    it('总表没列这章：按 book-text 判断', async () => {
        mockProofIndex.mockReset().mockResolvedValue({ other: { '001': { rev: 'r', n: 3 } } });
        await show(plainIndex);
        expect(screen.queryByTestId('proofing-notice')).toBeNull();
    });
});

describe('书名栏的文本版本号', () => {
    const idx = { chapters: [{ n: 1, file: '001', title: '卷首', text_version: '0.1.4', punct_version: '0.1.1', entity_version: '0.1.1' }] };
    const show = async (isOriginal: boolean) => {
        getTextManifest.mockReset().mockResolvedValue({ id: ZHIZHAI, versions: [{ key: 'default', kind: 'self_collated', label: '自校本', is_original: isOriginal }] });
        getTextIndex.mockReset().mockResolvedValue(idx);
        render(<ReaderClient id={ZHIZHAI} initial={{ chapter: '001' }} bookTitle="t" />);
        await act(async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); });
    };
    beforeEach(() => { mockProofIndex.mockReset().mockResolvedValue(null); });

    it('本项目自做的版本：书名后显示文本版本号', async () => {
        await show(true);
        render(<>{last.reader?.subtitle as React.ReactNode}</>);
        expect(screen.getByTestId('text-version').textContent).toBe('文本 v0.1.4');
    });
    it('外来版本：不出版本号，书名栏照旧', async () => {
        await show(false);
        expect(last.reader?.subtitle).toBeUndefined();
    });
});
