/**
 * 检索框候选（overview#342）：首页、元数据首页共用的 SearchSuggest 与 lib/search/suggest。
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';

const push = jest.fn();
jest.mock('next/navigation', () => ({
    useRouter: () => ({ push }),
}));

import SearchSuggest from '../SearchSuggest';
import { clearSuggestCache, fetchSuggestions, pushSearchHistory, readSearchHistory, toSuggestions } from '@/lib/search/suggest';
import { writeSiteLocale } from '@/lib/site-locale';

const PROXY = {
    results: [
        { indexUid: 'entities', hits: [{ id: 'e1', type: 'entity', primary_name: '武職人', dynasty: '明' }] },
        { indexUid: 'works', hits: [
            { id: 'd59f2nfhf8cg', type: 'work', title: '武職選簿', author: '兵部武選司', dynasty: '明' },
            { id: 'w2', type: 'work', title: '武職選簿·錦衣衛', author: '', dynasty: '' },
        ] },
        { indexUid: 'books', hits: [{ id: 'b1', type: 'book', title: '武職選簿 明鈔本' }] },
        { indexUid: 'collections', hits: [] },
    ],
};

function mockProxy(body: unknown = PROXY, ok = true) {
    const fn = jest.fn(async () => ({ ok, status: ok ? 200 : 503, json: async () => body }) as Response);
    global.fetch = fn as unknown as typeof fetch;
    return fn;
}

function Harness({ onSubmit }: { onSubmit?: (q: string) => void }) {
    const [q, setQ] = useState('');
    return (
        <form
            role="search"
            onSubmit={(e) => { e.preventDefault(); onSubmit?.(q); }}
        >
            <SearchSuggest value={q} onChange={setQ} aria-label="检索" />
            <button type="submit">搜索</button>
        </form>
    );
}

beforeEach(() => {
    push.mockClear();
    localStorage.clear();
    clearSuggestCache();
});

describe('toSuggestions／fetchSuggestions', () => {
    it('按作品、书、丛编、人物排，书名缺了用 primary_name，最多 8 条', () => {
        const list = toSuggestions(PROXY);
        expect(list.map((e) => e.id)).toEqual(['d59f2nfhf8cg', 'w2', 'b1', 'e1']);
        expect(list[3].title).toBe('武職人');
        expect(list[1].author).toBeUndefined();
        const many = { results: [{ indexUid: 'works', hits: Array.from({ length: 12 }, (_, i) => ({ id: `w${i}`, type: 'work', title: `t${i}` })) }] };
        expect(toSuggestions(many)).toHaveLength(8);
        expect(() => toSuggestions({})).toThrow();
    });

    it('调同站 /api/search（四类一次请求，带 locale），同词同 locale 只请求一次；失败抛错', async () => {
        const fn = mockProxy();
        await fetchSuggestions(' 武職 ', 'zh-Hans');
        await fetchSuggestions('武職', 'zh-Hans');
        expect(fn).toHaveBeenCalledTimes(1);
        expect(String((fn.mock.calls[0] as unknown[])[0])).toBe(`/api/search?q=${encodeURIComponent('武職')}&limit=8&locale=zh-Hans`);
        // 换了繁简要重新取（服务端按 locale 出字）
        await fetchSuggestions('武職', 'zh-Hant');
        expect(fn).toHaveBeenCalledTimes(2);
        expect(String((fn.mock.calls[1] as unknown[])[0])).toContain('locale=zh-Hant');
        mockProxy(null, false);
        await expect(fetchSuggestions('史記', 'zh-Hans')).rejects.toThrow('HTTP 503');
    });
});

describe('SearchSuggest', () => {
    it('默认简体：请求带 locale=zh-Hans，候选出代理转好的简体；切繁体后带 zh-Hant 重取', async () => {
        const SIMP = { results: [{ indexUid: 'works', hits: [{ id: 'd59f2nfhf8cg', type: 'work', title: '武职选簿', author: '兵部武选司', dynasty: '明' }] }] };
        const fn = jest.fn(async (u: RequestInfo | URL) => ({
            ok: true, status: 200,
            json: async () => (String(u).includes('locale=zh-Hans') ? SIMP : PROXY),
        }) as Response);
        global.fetch = fn as unknown as typeof fetch;
        render(<Harness />);
        const box = screen.getByRole('combobox');
        fireEvent.focus(box);
        fireEvent.change(box, { target: { value: '武职' } });
        const [first] = await screen.findAllByRole('option');
        expect(first).toHaveTextContent('作品武职选簿明 兵部武选司');
        expect(String((fn.mock.calls[0] as unknown[])[0])).toContain('locale=zh-Hans');

        act(() => writeSiteLocale('zh-Hant'));
        await waitFor(() => expect(screen.getAllByRole('option')[0]).toHaveTextContent('作品武職選簿明 兵部武選司'));
        expect(String((fn.mock.calls.at(-1) as unknown[])[0])).toContain('locale=zh-Hant');
        act(() => writeSiteLocale('zh-Hans'));
    });

    it('输入出候选，点条目去 /item/<id>', async () => {
        mockProxy();
        render(<Harness />);
        const box = screen.getByRole('combobox', { name: '检索' });
        fireEvent.focus(box);
        fireEvent.change(box, { target: { value: '武職' } });
        const opts = await screen.findAllByRole('option');
        expect(opts).toHaveLength(4);
        expect(opts[0]).toHaveTextContent('作品武職選簿明 兵部武選司');
        expect(opts[2]).toHaveTextContent('书');
        expect(box).toHaveAttribute('aria-expanded', 'true');
        fireEvent.click(opts[0]);
        expect(push).toHaveBeenCalledWith('/item/d59f2nfhf8cg');
        expect(screen.queryByRole('listbox')).toBeNull();
    });

    it('↑↓ 选、回车进条目；没选中时回车照常提交表单；Esc 收起', async () => {
        mockProxy();
        const onSubmit = jest.fn();
        render(<Harness onSubmit={onSubmit} />);
        const box = screen.getByRole('combobox');
        fireEvent.focus(box);
        fireEvent.change(box, { target: { value: '武職' } });
        await screen.findAllByRole('option');
        fireEvent.keyDown(box, { key: 'ArrowDown' });
        fireEvent.keyDown(box, { key: 'ArrowDown' });
        const opts = screen.getAllByRole('option');
        expect(opts[1]).toHaveAttribute('aria-selected', 'true');
        expect(box).toHaveAttribute('aria-activedescendant', opts[1].id);
        fireEvent.keyDown(box, { key: 'ArrowUp' });
        fireEvent.keyDown(box, { key: 'Enter' });
        expect(push).toHaveBeenCalledWith('/item/d59f2nfhf8cg');

        fireEvent.focus(box);
        fireEvent.change(box, { target: { value: '武職選' } });
        await screen.findAllByRole('option');
        fireEvent.keyDown(box, { key: 'Escape' });
        expect(screen.queryByRole('listbox')).toBeNull();
        // 回车（不在下拉里）交给表单：jsdom 不会因回车自动提交，这里直接提交
        fireEvent.submit(box.closest('form')!);
        expect(onSubmit).toHaveBeenCalledWith('武職選');
        // 提交记进最近检索（与结果页共用 bim-search-history）
        expect(readSearchHistory()).toEqual(['武職選']);
    });

    it('输入法组字时的回车不算', async () => {
        mockProxy();
        render(<Harness />);
        const box = screen.getByRole('combobox');
        fireEvent.focus(box);
        fireEvent.change(box, { target: { value: '武職' } });
        await screen.findAllByRole('option');
        fireEvent.keyDown(box, { key: 'ArrowDown' });
        fireEvent.keyDown(box, { key: 'Enter', keyCode: 229 });
        expect(push).not.toHaveBeenCalled();
    });

    it('代理不通：不出下拉，检索照常', async () => {
        const fn = mockProxy(null, false);
        render(<Harness />);
        const box = screen.getByRole('combobox');
        fireEvent.focus(box);
        fireEvent.change(box, { target: { value: '武職' } });
        await waitFor(() => expect(fn).toHaveBeenCalled());
        await act(async () => {});
        expect(screen.queryByRole('listbox')).toBeNull();
        expect(box).toHaveAttribute('aria-expanded', 'false');
    });

    it('空框聚焦出最近检索：点一条就用它提交；可删一条、可清空', async () => {
        pushSearchHistory('史記');
        pushSearchHistory('蘇軾');
        const onSubmit = jest.fn();
        render(<Harness onSubmit={onSubmit} />);
        const box = screen.getByRole('combobox');
        fireEvent.focus(box);
        const opts = screen.getAllByRole('option');
        expect(opts.map((o) => o.textContent)).toEqual(['蘇軾×', '史記×']);
        fireEvent.click(screen.getByRole('button', { name: '删除「蘇軾」' }));
        expect(readSearchHistory()).toEqual(['史記']);
        fireEvent.click(screen.getByRole('option'));
        expect(onSubmit).toHaveBeenCalledWith('史記');
        expect(box).toHaveValue('史記');

        fireEvent.change(box, { target: { value: '' } });
        fireEvent.focus(box);
        fireEvent.click(screen.getByRole('button', { name: '清空' }));
        expect(readSearchHistory()).toEqual([]);
        expect(screen.queryByRole('listbox')).toBeNull();
    });
});
