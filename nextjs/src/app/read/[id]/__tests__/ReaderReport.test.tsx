/**
 * v4 P2（overview#299）：阅读器「报告错字」→ 同一个反馈弹窗，带上条目 id、版本与章标签、选中文字与位置锚点。
 * 阅读器组件换成桩，这里只测接线。
 */
import { act, render } from '@testing-library/react';

jest.mock('next/navigation', () => ({ useRouter: () => ({ push: jest.fn() }), usePathname: () => '/read/d59f2htm01du' }));
jest.mock('@/components/layout/LayoutWrapper', () => ({ children }: { children: React.ReactNode }) => <main>{children}</main>);
jest.mock('@/components/common/SourceContext', () => ({ useSource: () => ({ source: 'cos' }) }));
const MANIFEST = { id: 'd59f2htm01du', versions: [{ key: 'default', kind: 'collated', label: '整理本' }] };
jest.mock('@/lib/transport', () => ({
    getTransport: () => ({
        getTextManifest: async () => MANIFEST,
        getTextIndex: async () => ({ chapters: [{ n: 11, file: '011', title: '史錄' }] }),
    }),
}));

const open = jest.fn();
jest.mock('@/components/feedback/FeedbackProvider', () => ({
    useFeedback: () => ({ open, setPageContext: jest.fn() }),
    useFeedbackPageContext: jest.fn(),
}));
jest.mock('@/components/feedback/SelectionReport', () => () => null);

const last: { reader?: Record<string, unknown> } = {};
jest.mock('book-index-ui', () => ({
    LocaleProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    // 反馈标签里的书名、版本名经 useConvert 转（不在 LocaleProvider 里时原样）
    useConvert: () => ({ convert: (s: string) => s }),
    TextReader: (p: Record<string, unknown>) => { last.reader = p; return null; },
    createTextApi: (t: { getTextManifest: (id: string) => Promise<unknown>; getTextIndex: (id: string, k: string) => Promise<unknown> }) => ({
        getManifest: (id: string) => t.getTextManifest(id),
        getIndex: (id: string, k: string) => t.getTextIndex(id, k),
    }),
}));

import ReaderClient from '../ReaderClient';

const ZHIZHAI = 'd59f2htm01du';

it('onReportError 打开「内容有误」弹窗，带条目 id、「书名 · 版本 · 卷N」标签、选中文字与锚点', async () => {
    render(<ReaderClient id={ZHIZHAI} initial={{ chapter: '011' }} bookTitle="直齋書錄解題" />);
    // 标签里的版本名来自 manifest，异步取到后才有
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    act(() => {
        (last.reader!.onReportError as (c: unknown) => void)({
            bookTitle: '直齋書錄解題', entryId: ZHIZHAI, chapterKey: '011', selectedText: '易者象也', anchor: 'rd-e-3',
        });
    });
    expect(open).toHaveBeenCalledWith({
        context: { resourceId: ZHIZHAI, label: '直齋書錄解題 · 卷11', quote: '易者象也', anchor: 'rd-e-3' },
        type: 'bug',
    });
});
