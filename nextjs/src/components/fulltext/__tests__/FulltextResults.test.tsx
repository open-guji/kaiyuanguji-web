/**
 * GUJI-163 F6 步 3：全文搜索结果列表。夹具即 F1 sample_response.json，不接生产搜索服务。
 */
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import sample from '@/lib/fulltext/__fixtures__/sample_response.json';
import type { FulltextResponse, FulltextError } from '@/lib/fulltext/fulltext-client';
import FulltextResults from '../FulltextResults';
import FulltextTab, { isFulltextEnabled } from '../FulltextTab';

const data = sample as unknown as FulltextResponse;

describe('FulltextResults', () => {
    it('按书分组渲染：书名、命中数、章标签（label 缺省用章号）', () => {
        render(<FulltextResults data={data} />);
        expect(screen.getByText('論語集解')).toBeTruthy();
        expect(screen.getByText('示例書名')).toBeTruthy();
        expect(screen.getByText('學而第一')).toBeTruthy();
        expect(screen.getByText('020')).toBeTruthy(); // label 为 null
    });

    it('snippet 里的 <mark> 渲染成高亮，命中文本在 mark 内', () => {
        const { container } = render(<FulltextResults data={data} />);
        const marks = container.querySelectorAll('mark');
        expect(marks.length).toBe(3);
        expect(marks[0].textContent).toBe('學而時習之');
    });

    it('snippet 里混进别的标签：转义成文本，DOM 里没有该元素（XSS）', () => {
        const evil: FulltextResponse = {
            ...data,
            groups: [{
                ...data.groups[0],
                title: '<img src=x onerror=alert(1)>',
                hits: [{ ...data.groups[0].hits[0], label: '<b>章</b>', snippet: '<img src=x onerror=alert(1)><mark>甲</mark><script>1</script>' }],
            }],
        };
        const { container } = render(<FulltextResults data={evil} />);
        expect(container.querySelector('img')).toBeNull();
        expect(container.querySelector('script')).toBeNull();
        expect(container.querySelector('b')).toBeNull();
        expect(container.querySelectorAll('mark').length).toBe(1);
        expect(container.textContent).toContain('<img src=x onerror=alert(1)>');
    });

    it('命中链接带章与首个命中区间（码点偏移）和 ftq 文本', () => {
        render(<FulltextResults data={data} />);
        const links = screen.getAllByRole('link');
        expect(links[0].getAttribute('href')).toBe(
            `/read/d59df01avcw0/001?ft=${encodeURIComponent('001:3-8')}&ftq=${encodeURIComponent('學而時習之')}`,
        );
    });

    it('has_more 时有「加载更多」，点了回调；没有则不显示', () => {
        const onMore = jest.fn();
        const { rerender } = render(<FulltextResults data={{ ...data, has_more: true }} onLoadMore={onMore} />);
        fireEvent.click(screen.getByRole('button', { name: '加载更多' }));
        expect(onMore).toHaveBeenCalledTimes(1);
        rerender(<FulltextResults data={{ ...data, has_more: false }} onLoadMore={onMore} />);
        expect(screen.queryByRole('button', { name: '加载更多' })).toBeNull();
    });

    it('capped／truncated 时提示结果不完整', () => {
        render(<FulltextResults data={{ ...data, capped: true }} />);
        expect(screen.getByText(/结果已截断/)).toBeTruthy();
    });

    it('无命中：显示“没有找到”', () => {
        render(<FulltextResults data={{ ...data, groups: [], total_hits: 0 }} />);
        expect(screen.getByText(/没有找到/)).toBeTruthy();
    });

    it.each<[FulltextError, RegExp]>([
        [{ ok: false, kind: 'unavailable', status: 503 }, /暂不可用/],
        [{ ok: false, kind: 'rate_limited', status: 429, retryAfterSec: 7 }, /7 秒/],
        [{ ok: false, kind: 'rate_limited', status: 429, retryAfterSec: null }, /稍后/],
        [{ ok: false, kind: 'timeout' }, /超时/],
        [{ ok: false, kind: 'offline' }, /网络/],
        [{ ok: false, kind: 'bad_query', status: 400 }, /关键词/],
        [{ ok: false, kind: 'bad_response' }, /暂不可用/],
    ])('错误 %j 映射成中文提示', (error, re) => {
        render(<FulltextResults error={error} />);
        expect(screen.getByRole('alert').textContent).toMatch(re);
    });
});

describe('FulltextTab 开关', () => {
    const OLD = process.env.NEXT_PUBLIC_FULLTEXT_TAB;
    afterEach(() => { process.env.NEXT_PUBLIC_FULLTEXT_TAB = OLD; });

    it('构建期开关关（默认）：DOM 中不含 tab', () => {
        delete process.env.NEXT_PUBLIC_FULLTEXT_TAB;
        expect(isFulltextEnabled()).toBe(false);
        const { container } = render(<FulltextTab q="學而" />);
        expect(container.innerHTML).toBe('');
    });

    /** 按地址分流的假 fetch：op=status 回 status，其余回 search */
    const route = (status: unknown, search: () => unknown) => jest.fn(async (url: string) =>
        (String(url).includes('op=status') ? status : search()));
    const res = (st: number, body?: unknown) => ({ ok: st >= 200 && st < 300, status: st, headers: new Headers(), json: async () => body ?? {} });

    it('构建期开关关：不查 status、不发请求', () => {
        delete process.env.NEXT_PUBLIC_FULLTEXT_TAB;
        const fetchImpl = jest.fn();
        render(<FulltextTab q="學而" fetchImpl={fetchImpl as unknown as typeof fetch} />);
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('开关开＋服务 503：tab 在、显示暂不可用', async () => {
        process.env.NEXT_PUBLIC_FULLTEXT_TAB = '1';
        const fetchImpl = route(res(200, { enabled: true }), () => res(503, { error: 'busy' }));
        render(<FulltextTab q="學而" fetchImpl={fetchImpl as unknown as typeof fetch} />);
        expect(await screen.findByRole('tab', { name: '全文' })).toBeTruthy();
        expect((await screen.findByRole('alert')).textContent).toMatch(/暂不可用/);
    });

    it('开关开＋夹具：渲染分组与命中', async () => {
        process.env.NEXT_PUBLIC_FULLTEXT_TAB = '1';
        const fetchImpl = route(res(200, { enabled: true }), () => res(200, sample));
        render(<FulltextTab q="學而時習之" fetchImpl={fetchImpl as unknown as typeof fetch} />);
        expect(await screen.findByText('論語集解')).toBeTruthy();
    });

    it('运行时开关关（status enabled:false）：不显示 tab、不发搜索请求', async () => {
        process.env.NEXT_PUBLIC_FULLTEXT_TAB = '1';
        const fetchImpl = route(res(200, { enabled: false, reason: '维护' }), () => res(200, sample));
        const { container } = render(<FulltextTab q="學而" fetchImpl={fetchImpl as unknown as typeof fetch} />);
        await waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
        await act(async () => { await Promise.resolve(); });
        expect(container.innerHTML).toBe('');
        expect(String(fetchImpl.mock.calls[0][0])).toContain('op=status');
    });

    it('查 status 失败：不显示 tab', async () => {
        process.env.NEXT_PUBLIC_FULLTEXT_TAB = '1';
        const fetchImpl = jest.fn(async () => { throw new TypeError('Failed to fetch'); });
        const { container } = render(<FulltextTab q="學而" fetchImpl={fetchImpl as unknown as typeof fetch} />);
        await waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
        await act(async () => { await Promise.resolve(); });
        expect(container.innerHTML).toBe('');
    });

    it('搜索回 503 disabled（开关刚关）：tab 立刻隐藏', async () => {
        process.env.NEXT_PUBLIC_FULLTEXT_TAB = '1';
        const fetchImpl = route(res(200, { enabled: true }), () => res(503, { error: 'disabled' }));
        const { container } = render(<FulltextTab q="學而" fetchImpl={fetchImpl as unknown as typeof fetch} />);
        await waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));
        await waitFor(() => expect(container.innerHTML).toBe(''));
        expect(screen.queryByRole('alert')).toBeNull();
    });
});
