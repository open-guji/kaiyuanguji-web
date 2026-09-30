/**
 * v4 P2（overview#299）：阅读器右栏「报告错字」→ 同一个反馈弹窗，带上条目 id、卷标签、选中文字与位置锚点。
 * 阅读器组件换成桩，这里只测接线。
 */
import { act, render } from '@testing-library/react';

jest.mock('next/navigation', () => ({ useRouter: () => ({ push: jest.fn() }), useSearchParams: () => new URLSearchParams() }));
jest.mock('@/components/layout/LayoutWrapper', () => ({ children }: { children: React.ReactNode }) => <main>{children}</main>);
jest.mock('@/components/common/SourceContext', () => ({ useSource: () => ({ source: 'cos' }) }));
jest.mock('@/lib/transport', () => ({ getTransport: () => ({}) }));

const open = jest.fn();
jest.mock('@/components/feedback/FeedbackProvider', () => ({
    useFeedback: () => ({ open, setPageContext: jest.fn() }),
    useFeedbackPageContext: jest.fn(),
}));
jest.mock('@/components/feedback/SelectionReport', () => () => null);

const last: { collated?: Record<string, unknown> } = {};
jest.mock('book-index-ui', () => ({
    LocaleProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    CollatedEdition: (p: Record<string, unknown>) => { last.collated = p; return null; },
    BookFullText: () => null,
}));

import ReaderClient from '../ReaderClient';

const ZHIZHAI = 'd59f2htm01du';

it('onReportError 打开「内容有误」弹窗，带条目 id、卷标签、选中文字与锚点', () => {
    render(<ReaderClient id={ZHIZHAI} initial={{ kind: 'collated', juan: '011' }} bookTitle="直齋書錄解題" />);
    act(() => {
        (last.collated!.onReportError as (c: unknown) => void)({
            bookTitle: '直齋書錄解題', entryId: ZHIZHAI, chapterKey: 'juan/011.json', selectedText: '易者象也', anchor: 'rd-e-3',
        });
    });
    expect(open).toHaveBeenCalledWith({
        context: { resourceId: ZHIZHAI, label: '直齋書錄解題 · 整理本 · 卷11', quote: '易者象也', anchor: 'rd-e-3' },
        type: 'bug',
    });
});
