/**
 * N7（overview#260）：反馈弹窗、页面上下文、阅读页选字「报错」。
 * 提交一律走 mock 的 fetch，不打任何线上站点。
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import FeedbackDialog from '../FeedbackDialog';
import { FeedbackProvider, useFeedback, useFeedbackPageContext } from '../FeedbackProvider';
import SelectionReport from '../SelectionReport';
import { CONTENT_MAX } from '@/lib/feedback';

const WORK = 'd59f20aowb9c';

function okFetch() {
    return jest.fn().mockResolvedValue({ ok: true, json: async () => ({ success: true }) });
}

function sentBody(fetchImpl: jest.Mock) {
    return JSON.parse(fetchImpl.mock.calls[0][1].body);
}

describe('FeedbackDialog', () => {
    it('是模态对话框，焦点落在正文输入框；Esc、点遮罩、关闭按钮都能关', () => {
        const onClose = jest.fn();
        const { container } = render(<FeedbackDialog initialContext={null} initialType="suggestion" onClose={onClose} />);
        const dialog = screen.getByRole('dialog', { name: '反馈' });
        expect(dialog).toHaveAttribute('aria-modal', 'true');
        expect(screen.getByRole('textbox', { name: '反馈内容' })).toHaveFocus();

        fireEvent.keyDown(window, { key: 'Escape' });
        fireEvent.mouseDown(container.querySelector('.og-fb-mask')!);
        fireEvent.click(screen.getByRole('button', { name: '关闭' }));
        expect(onClose).toHaveBeenCalledTimes(3);
    });

    it('点在弹窗里面不关', () => {
        const onClose = jest.fn();
        render(<FeedbackDialog initialContext={null} initialType="suggestion" onClose={onClose} />);
        fireEvent.mouseDown(screen.getByRole('dialog'));
        expect(onClose).not.toHaveBeenCalled();
    });

    it('Tab 困在弹窗里', () => {
        render(<FeedbackDialog initialContext={null} initialType="bug" onClose={() => {}} />);
        const dialog = screen.getByRole('dialog');
        const items = dialog.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), textarea, input');
        const first = items[0];
        const last = items[items.length - 1];
        last.focus();
        fireEvent.keyDown(window, { key: 'Tab' });
        expect(first).toHaveFocus();
        fireEvent.keyDown(window, { key: 'Tab', shiftKey: true });
        expect(last).toHaveFocus();
    });

    it('类型是一组单选页签，默认选中传入的那个，可切换，占位文案跟着变', () => {
        render(<FeedbackDialog initialContext={null} initialType="suggestion" onClose={() => {}} />);
        const group = screen.getByRole('radiogroup', { name: '反馈类型' });
        const radios = within(group).getAllByRole('radio');
        expect(radios.map((r) => r.textContent)).toEqual(['内容有误', '补充资源', '功能建议', '想参与']);
        expect(within(group).getByRole('radio', { name: '功能建议' })).toHaveAttribute('aria-checked', 'true');
        fireEvent.click(within(group).getByRole('radio', { name: '补充资源' }));
        expect(within(group).getByRole('radio', { name: '补充资源' })).toHaveAttribute('aria-checked', 'true');
        expect(screen.getByRole('textbox', { name: '反馈内容' })).toHaveAttribute('placeholder', expect.stringContaining('影印本'));
    });

    it('正文为空时「提交」不可点', () => {
        render(<FeedbackDialog initialContext={null} initialType="bug" onClose={() => {}} />);
        const submit = screen.getByRole('button', { name: '提交' });
        expect(submit).toBeDisabled();
        fireEvent.change(screen.getByRole('textbox', { name: '反馈内容' }), { target: { value: '   ' } });
        expect(submit).toBeDisabled();
    });

    it('显示并提交上下文：条目 id 进 resourceId，选中文字拼在正文开头，pageUrl 是当前地址', async () => {
        const fetchImpl = okFetch();
        const onSubmitted = jest.fn();
        render(
            <FeedbackDialog
                initialContext={{ resourceId: WORK, label: '直斋书录解题 · 整理本 · 卷4', quote: '高堂生所传士礼也' }}
                initialType="bug"
                onClose={() => {}}
                onSubmitted={onSubmitted}
                fetchImpl={fetchImpl}
            />,
        );
        expect(screen.getByText('直斋书录解题 · 整理本 · 卷4')).toBeInTheDocument();
        expect(screen.getByText('高堂生所传士礼也')).toBeInTheDocument();

        fireEvent.change(screen.getByRole('textbox', { name: '反馈内容' }), { target: { value: '标点有误' } });
        fireEvent.change(screen.getByRole('textbox', { name: '联系方式（选填）' }), { target: { value: 'a@example.org' } });
        fireEvent.click(screen.getByRole('button', { name: '提交' }));

        await screen.findByRole('status');
        expect(sentBody(fetchImpl)).toEqual({
            type: 'bug',
            content: '【原文】高堂生所传士礼也\n\n标点有误',
            contact: 'a@example.org',
            pageUrl: window.location.href,
            resourceId: WORK,
        });
        expect(onSubmitted).toHaveBeenCalled();
        expect(screen.getByRole('link', { name: '反馈列表' })).toHaveAttribute('href', '/feedback');
    });

    it('「不带上」去掉上下文：不发 resourceId，正文不加原文', async () => {
        const fetchImpl = okFetch();
        render(
            <FeedbackDialog
                initialContext={{ resourceId: WORK, label: '史记 · 作品', quote: '原文' }}
                initialType="bug"
                onClose={() => {}}
                fetchImpl={fetchImpl}
            />,
        );
        fireEvent.click(screen.getByRole('button', { name: '不带上' }));
        expect(screen.queryByText('史记 · 作品')).not.toBeInTheDocument();
        fireEvent.change(screen.getByRole('textbox', { name: '反馈内容' }), { target: { value: '别的事' } });
        fireEvent.click(screen.getByRole('button', { name: '提交' }));
        await screen.findByRole('status');
        expect(sentBody(fetchImpl)).toMatchObject({ content: '别的事', resourceId: '' });
    });

    it('选中文字占掉的字数从正文上限里扣掉', () => {
        render(<FeedbackDialog initialContext={{ quote: '十个字十个字十个字十' }} initialType="bug" onClose={() => {}} />);
        const max = Number(screen.getByRole('textbox', { name: '反馈内容' }).getAttribute('maxLength'));
        expect(max).toBeLessThan(CONTENT_MAX);
        expect(max).toBe(CONTENT_MAX - '【原文】十个字十个字十个字十\n\n'.length);
    });

    it('后端报错时显示错误，表单保留，可再提交', async () => {
        const fetchImpl = jest.fn().mockResolvedValue({ ok: false, json: async () => ({ error: '提交太频繁，请稍后再试' }) });
        render(<FeedbackDialog initialContext={null} initialType="bug" onClose={() => {}} fetchImpl={fetchImpl} />);
        fireEvent.change(screen.getByRole('textbox', { name: '反馈内容' }), { target: { value: '有错' } });
        fireEvent.click(screen.getByRole('button', { name: '提交' }));
        expect(await screen.findByRole('alert')).toHaveTextContent('提交太频繁，请稍后再试');
        expect(screen.getByRole('textbox', { name: '反馈内容' })).toHaveValue('有错');
        expect(screen.getByRole('button', { name: '提交' })).toBeEnabled();
    });

    it('「想参与」写明不公开，成功后不引去反馈列表', async () => {
        const fetchImpl = okFetch();
        render(<FeedbackDialog initialContext={null} initialType="contact" onClose={() => {}} fetchImpl={fetchImpl} />);
        expect(screen.getByText('这类留言不公开，只有站方能看到')).toBeInTheDocument();
        fireEvent.change(screen.getByRole('textbox', { name: '反馈内容' }), { target: { value: '想参与校对' } });
        fireEvent.click(screen.getByRole('button', { name: '提交' }));
        await screen.findByRole('status');
        expect(screen.queryByRole('link', { name: '反馈列表' })).not.toBeInTheDocument();
        expect(sentBody(fetchImpl).type).toBe('contact');
    });
});

function PageWith({ ctx }: { ctx: { resourceId?: string; label?: string } | null }) {
    useFeedbackPageContext(ctx);
    const { open } = useFeedback();
    return <button type="button" onClick={() => open()}>打开</button>;
}

describe('FeedbackProvider 与页面上下文', () => {
    it('页面登记了上下文，从别处（导航栏）打开也带上，类型默认「内容有误」', () => {
        render(<FeedbackProvider><PageWith ctx={{ resourceId: WORK, label: '史记 · 作品' }} /></FeedbackProvider>);
        fireEvent.click(screen.getByRole('button', { name: '打开' }));
        expect(screen.getByText('史记 · 作品')).toBeInTheDocument();
        expect(screen.getByRole('radio', { name: '内容有误' })).toHaveAttribute('aria-checked', 'true');
    });

    it('没有上下文时不显示「关于」，类型默认「功能建议」', () => {
        render(<FeedbackProvider><PageWith ctx={null} /></FeedbackProvider>);
        fireEvent.click(screen.getByRole('button', { name: '打开' }));
        expect(screen.queryByText('关于')).not.toBeInTheDocument();
        expect(screen.getByRole('radio', { name: '功能建议' })).toHaveAttribute('aria-checked', 'true');
    });

    it('页面卸载后上下文清掉', () => {
        function Opener() {
            const { open } = useFeedback();
            return <button type="button" onClick={() => open()}>另一个</button>;
        }
        const { rerender } = render(
            <FeedbackProvider><PageWith ctx={{ resourceId: WORK, label: '史记 · 作品' }} /><Opener /></FeedbackProvider>,
        );
        rerender(<FeedbackProvider><Opener /></FeedbackProvider>);
        fireEvent.click(screen.getByRole('button', { name: '另一个' }));
        expect(screen.queryByText('史记 · 作品')).not.toBeInTheDocument();
    });

    it('不在 Provider 里调用不报错', () => {
        render(<PageWith ctx={null} />);
        expect(() => fireEvent.click(screen.getByRole('button', { name: '打开' }))).not.toThrow();
    });
});

describe('SelectionReport（阅读页选字「报错」）', () => {
    beforeAll(() => {
        // jsdom 没有布局，Range 量不出位置
        Range.prototype.getBoundingClientRect = () => ({ left: 100, top: 200, width: 80, height: 20, right: 180, bottom: 220, x: 100, y: 200, toJSON: () => ({}) }) as DOMRect;
    });
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => {
        jest.useRealTimers();
        window.getSelection()?.removeAllRanges();
    });

    function Harness() {
        const ref = { current: null as HTMLDivElement | null };
        return (
            <FeedbackProvider>
                <div ref={(el) => { ref.current = el; }}>
                    <p data-testid="text">《仪礼》十七卷　郑氏注。高堂生所传士礼也。</p>
                    <input aria-label="检索" defaultValue="检索词" />
                </div>
                <p data-testid="outside">页外文字</p>
                <SelectionReport containerRef={ref} context={{ resourceId: WORK, label: '直斋书录解题 · 整理本 · 卷4' }} />
            </FeedbackProvider>
        );
    }

    function select(node: Node, start: number, end: number) {
        const range = document.createRange();
        range.setStart(node, start);
        range.setEnd(node, end);
        const sel = window.getSelection()!;
        sel.removeAllRanges();
        sel.addRange(range);
        act(() => {
            document.dispatchEvent(new Event('selectionchange'));
            jest.advanceTimersByTime(250);
        });
    }

    it('正文里选中文字后出「复制 ｜ 报错」，点「报错」打开弹窗并带上选中的文字与本卷', () => {
        render(<Harness />);
        const textNode = screen.getByTestId('text').firstChild!;
        const full = textNode.textContent!;
        const start = full.indexOf('高堂生');
        select(textNode, start, start + '高堂生所传士礼也'.length);

        const bar = screen.getByRole('toolbar', { name: '选中文字' });
        expect(within(bar).getAllByRole('button').map((b) => b.textContent)).toEqual(['复制', '报错']);
        fireEvent.click(within(bar).getByRole('button', { name: '报错' }));

        expect(screen.queryByRole('toolbar')).not.toBeInTheDocument();
        const dialog = screen.getByRole('dialog', { name: '反馈' });
        expect(within(dialog).getByText('直斋书录解题 · 整理本 · 卷4')).toBeInTheDocument();
        expect(within(dialog).getByText('高堂生所传士礼也')).toBeInTheDocument();
        expect(within(dialog).getByRole('radio', { name: '内容有误' })).toHaveAttribute('aria-checked', 'true');
    });

    it('选区在正文外，或没选中东西，不出浮条', () => {
        render(<Harness />);
        select(screen.getByTestId('outside').firstChild!, 0, 2);
        expect(screen.queryByRole('toolbar')).not.toBeInTheDocument();
        const textNode = screen.getByTestId('text').firstChild!;
        select(textNode, 3, 3);
        expect(screen.queryByRole('toolbar')).not.toBeInTheDocument();
    });

    it('「复制」写进剪贴板', async () => {
        const writeText = jest.fn().mockResolvedValue(undefined);
        Object.assign(navigator, { clipboard: { writeText } });
        render(<Harness />);
        const textNode = screen.getByTestId('text').firstChild!;
        select(textNode, 0, 4);
        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: '复制' }));
        });
        expect(writeText).toHaveBeenCalledWith('《仪礼》');
        await waitFor(() => expect(screen.getByRole('button', { name: '已复制' })).toBeInTheDocument());
    });
});
