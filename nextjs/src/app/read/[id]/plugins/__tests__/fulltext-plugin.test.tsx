/**
 * @jest-environment jsdom
 *
 * 全文搜索定位插件（kyg:fulltext）：地址带 ?ft= 且章号一致时，用阅读器接口 locate／scrollTo 滚到命中处，角上出提示。
 */
import { act, fireEvent, render, screen } from '@testing-library/react';
import { fakeApi } from '@/test-utils/reader-fake-api';
import { fulltextPlugin } from '../fulltext-plugin';

const CELLS = [{ anchor: '1:1:1', char: '學' }, { anchor: '1:1:2', char: '而' }, { anchor: '1:1:3', char: '時' }];

function mount(search: string, o: { chapterKey?: string; cells?: typeof CELLS; locate?: (q: unknown) => string | null } = {}) {
    window.history.replaceState(null, '', `/read/x/001${search}`);
    const f = fakeApi({
        cells: o.cells ?? CELLS,
        ctx: { chapterKey: o.chapterKey ?? '001' },
        locate: (o.locate ?? (() => '1:1:2')) as never,
    });
    const view = render(<>{fulltextPlugin.overlay!(f.api)}</>);
    return { ...f, view };
}

describe('fulltext 插件', () => {
    it('没有 ?ft：不渲染、不定位', () => {
        const { calls, view } = mount('');
        expect(view.container.innerHTML).toBe('');
        expect(calls.scrollTo).toEqual([]);
    });

    it('章号一致：locate({text}) 找到格位，滚到中央，并显示提示（可关）', async () => {
        const locate = jest.fn(() => '1:1:2');
        const { calls } = mount('?ft=001:1-3&ftq=%E8%80%8C', { locate });
        expect(locate).toHaveBeenCalledWith({ text: '而' });
        expect(calls.scrollTo).toEqual([['1:1:2', { block: 'center' }]]);
        expect(screen.getByRole('status').textContent).toContain('而');
        await act(async () => { fireEvent.click(screen.getByRole('button')); });
        expect(screen.queryByRole('status')).toBeNull();
    });

    it('章号不一致：不定位、不提示', () => {
        const { calls } = mount('?ft=002:1-3&ftq=%E8%80%8C');
        expect(calls.scrollTo).toEqual([]);
        expect(screen.queryByRole('status')).toBeNull();
    });

    it('没有逐字格位的章：正文晚渲染，locate 先 null 后有记号，重试后滚到', async () => {
        jest.useFakeTimers();
        try {
            let ready = false;
            const { calls } = mount('?ft=001:1-3&ftq=%E8%80%8C', { cells: [], locate: () => (ready ? 't:5' : null) });
            await act(async () => { jest.advanceTimersByTime(700); });
            expect(calls.scrollTo).toEqual([]);
            ready = true;
            await act(async () => { jest.advanceTimersByTime(400); });
            expect(calls.scrollTo).toEqual([['t:5', { block: 'center' }]]);
        } finally { jest.useRealTimers(); }
    });

    it('只滚一次（换了 api 对象重渲染也不再抢滚动）', () => {
        const { calls, view } = mount('?ft=001:1-3&ftq=%E8%80%8C');
        const again = fakeApi({ cells: CELLS, ctx: { chapterKey: '001' }, locate: () => '1:1:2' });
        view.rerender(<>{fulltextPlugin.overlay!(again.api)}</>);
        expect(calls.scrollTo.length).toBe(1);
        expect(again.calls.scrollTo.length).toBe(0);
    });
});
