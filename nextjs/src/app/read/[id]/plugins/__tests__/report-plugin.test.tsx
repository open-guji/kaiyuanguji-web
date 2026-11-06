/**
 * @jest-environment jsdom
 *
 * 选字「复制 ｜ 報錯」与点字「改字」（阅读器插件 kyg:report）。
 * 阅读器本体不在场：用假的 ReaderApi 直接走插件的钩子（选字动作、点字、浮层）。
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReaderSelection } from 'book-index-ui';
import { FeedbackProvider, useFeedback } from '@/components/feedback/FeedbackProvider';
import { getSiteT } from '@/i18n/translate';
import { fakeApi, rect } from '@/test-utils/reader-fake-api';

const mockLoad = jest.fn();
jest.mock('book-index-ui', () => ({ loadReaderFiles: (...a: unknown[]) => mockLoad(...a) }));

import { reportPlugin } from '../report-plugin';

const ID = 'kyg:report';
const CELLS = [{ anchor: '3:1:4', char: '庫' }, { anchor: '3:1:5', char: '全' }, { anchor: '3:1:6', char: '總' }, { anchor: '3:1:7', char: '目' }];
const state = (textVersion = '1.0.1') => ({ book: '96mid1ogzk', volume: '002', chapter: '002', textVersion, entities: [], entityVersion: '' });
const sel = (anchors: string[]): ReaderSelection => ({ anchors, text: anchors.map(a => CELLS.find(c => c.anchor === a)!.char).join(''), rect: rect(100, 200) });
const okFetch = () => jest.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ success: true }) });

function setup(st: unknown, fetchImpl?: jest.Mock) {
    const opened: unknown[] = [];
    const plugin = reportPlugin({
        getFeedbackContext: () => ({ resourceId: 'w1', label: '四庫總目 · 卷二' }),
        openFeedback: (a) => opened.push(a),
        getT: () => getSiteT('zh-Hans'),
        fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const f = fakeApi({ cells: CELLS, state: st ? { [ID]: st } : {}, rects: { '3:1:5': rect(100, 100) } });
    return { plugin, opened, ...f };
}

describe('report 插件：选字浮条', () => {
    it('出「复制」「报错」两个按钮', () => {
        const { plugin, api } = setup(null);
        expect(plugin.selectionActions!(sel(['3:1:4']), api).map(a => a.label)).toEqual(['复制', '报错']);
    });

    it('「复制」写进剪贴板（按阅读顺序拼起来），然后刷新成「已复制」', async () => {
        const writeText = jest.fn().mockResolvedValue(undefined);
        Object.assign(navigator, { clipboard: { writeText } });
        const { plugin, api, calls } = setup(null);
        const s = sel(['3:1:5', '3:1:6']);
        await act(async () => { plugin.selectionActions!(s, api)[0].onClick(); });
        expect(writeText).toHaveBeenCalledWith('全總');
        expect(calls.refresh.length).toBe(1);
        expect(plugin.selectionActions!(s, api)[0].label).toBe('已复制');
        // 换了选区，恢复成「复制」
        expect(plugin.selectionActions!(sel(['3:1:4']), api)[0].label).toBe('复制');
    });

    it('本章不是对读章（没有状态）：「报错」开通用反馈弹窗，带本页上下文与选中的字', () => {
        const { plugin, api, opened } = setup(null);
        plugin.selectionActions!(sel(['3:1:4', '3:1:5']), api)[1].onClick();
        expect(opened).toEqual([{ context: { resourceId: 'w1', label: '四庫總目 · 卷二', quote: '庫全' }, type: 'bug' }]);
    });

    it('缺文本版本：同样开通用反馈弹窗', () => {
        const { plugin, api, opened } = setup(state(''));
        plugin.selectionActions!(sel(['3:1:4']), api)[1].onClick();
        expect(opened.length).toBe(1);
    });

    it('对读章：「报错」→「这段有问题」(kind=span)，带首末格位与原字，选类别、填应作后提交', async () => {
        const fetchImpl = okFetch();
        const { plugin, api } = setup(state(), fetchImpl);
        render(<FeedbackProvider>{plugin.overlay!(api)}</FeedbackProvider>);
        act(() => { plugin.selectionActions!(sel(['3:1:5', '3:1:6']), api)[1].onClick(); });
        const dialog = screen.getByRole('dialog', { name: '这段有问题' });
        expect(within(dialog).getByText('第 3 页 1 列 5 格起，共 2 字')).toBeInTheDocument();
        expect(within(dialog).getByText('选中：「全總」')).toBeInTheDocument();
        const submit = within(dialog).getByRole('button', { name: '提交' });
        expect(submit).toBeDisabled();
        fireEvent.change(within(dialog).getByRole('combobox'), { target: { value: 'missing' } });
        fireEvent.change(within(dialog).getByPlaceholderText(/应作什么/), { target: { value: '全書總' } });
        expect(submit).toBeEnabled();
        await act(async () => { fireEvent.click(submit); });
        expect(fetchImpl.mock.calls[0][0]).toBe('/api/charfix');
        expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toMatchObject({ kind: 'span', book_id: '96mid1ogzk', volume: '002', text_version: '1.0.1', start: '3:1:5', end: '3:1:6', sub: 'missing', old_text: '全總', new_text: '全書總' });
        await waitFor(() => expect(within(dialog).getByRole('status')).toBeInTheDocument());
    });

    it('应作与原文相同不收；只填说明可以', () => {
        const { plugin, api } = setup(state(), okFetch());
        render(<FeedbackProvider>{plugin.overlay!(api)}</FeedbackProvider>);
        act(() => { plugin.selectionActions!(sel(['3:1:4']), api)[1].onClick(); });
        const dialog = screen.getByRole('dialog', { name: '这段有问题' });
        fireEvent.change(within(dialog).getByPlaceholderText(/应作什么/), { target: { value: '庫' } });
        expect(within(dialog).getByRole('alert')).toHaveTextContent('与选中的原文相同');
        expect(within(dialog).getByRole('button', { name: '提交' })).toBeDisabled();
        fireEvent.change(within(dialog).getByPlaceholderText(/应作什么/), { target: { value: '' } });
        fireEvent.change(within(dialog).getByPlaceholderText(/哪里不对/), { target: { value: '书影作「库」' } });
        expect(within(dialog).getByRole('button', { name: '提交' })).toBeEnabled();
    });
});

describe('report 插件：点字改字', () => {
    it('点对读字：字旁浮出「第 3 页 1 列 5 格「全」」条；点 × 收起', () => {
        const { plugin, api } = setup(state());
        render(<FeedbackProvider>{plugin.overlay!(api)}</FeedbackProvider>);
        expect(screen.queryByRole('toolbar')).toBeNull();
        act(() => { plugin.onCell!.click!({ anchor: '3:1:5', char: '全', rect: rect(100, 100) }, api); });
        expect(screen.getByRole('toolbar').textContent).toContain('第 3 页 1 列 5 格「全」');
        fireEvent.click(screen.getByLabelText('关闭'));
        expect(screen.queryByRole('toolbar')).toBeNull();
    });

    it('纯 .txt 章（没有改字状态）或字没渲染出来（无矩形）不出入口', () => {
        const none = setup(null);
        render(<FeedbackProvider>{none.plugin.overlay!(none.api)}</FeedbackProvider>);
        act(() => { none.plugin.onCell!.click!({ anchor: '3:1:5', char: '全', rect: rect(100, 100) }, none.api); });
        expect(screen.queryByRole('toolbar')).toBeNull();
        const norect = setup(state());
        render(<FeedbackProvider>{norect.plugin.overlay!(norect.api)}</FeedbackProvider>);
        act(() => { norect.plugin.onCell!.click!({ anchor: '3:1:5', char: '全', rect: null }, norect.api); });
        expect(screen.queryByRole('toolbar')).toBeNull();
    });
});

describe('report 插件：onChapter', () => {
    const ctx = (chapter: Record<string, unknown>) => fakeApi({ ctx: { chapter: chapter as never, chapterKey: String(chapter.file) } }).api.ctx;

    it('取对读数据：文本版本取章条目的 text_version，缺则 char.json 的 version；专名取 entity.json', async () => {
        mockLoad.mockResolvedValueOnce({
            char: { version: '0.9.0' },
            entity: { version: '1.8.12', entities: [{ id: 'e00001', text: '紀昀', anchor: { start: '4:3:7', end: '4:3:9' } }] },
        });
        const { plugin } = setup(null);
        const st = await plugin.onChapter!(ctx({ file: '002' }));
        expect(st).toMatchObject({ book: '96mid1ogzk', volume: '002', chapter: '002', textVersion: '0.9.0', entityVersion: '1.8.12', entities: [{ id: 'e00001', start: '4:3:7', end: '4:3:9', text: '紀昀' }] });
        mockLoad.mockResolvedValueOnce({ char: {}, entity: null });
        expect(await plugin.onChapter!(ctx({ file: '002', text_version: '1.0.1', entity_version: '1.0.0' }))).toMatchObject({ textVersion: '1.0.1', entityVersion: '1.0.0' });
    });

    it('没有对读数据：无状态（不出改字入口）', async () => {
        mockLoad.mockResolvedValueOnce(null);
        const { plugin } = setup(null);
        expect(await plugin.onChapter!(ctx({ file: '002' }))).toBeUndefined();
    });
});
