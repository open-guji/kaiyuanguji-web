/**
 * GUJI-597：整册读者意见页 /feedback/text?book=&vol=，以及 lib/fixes 的解析与并组。
 */
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import TextFixesContent from '../TextFixesContent';
import { groupFixes, parsePublicFixes, cellCompare, fixesPageHref } from '@/lib/fixes';

let search = 'book=96mid1ogzk&vol=002';
jest.mock('next/navigation', () => ({
    useSearchParams: () => new URLSearchParams(search),
}));
jest.mock('@/components/common/SourceContext', () => ({ useSource: () => ({ source: 'cos' }) }));
const getEntry = jest.fn();
jest.mock('@/lib/transport', () => ({ getTransport: () => ({ getEntry: (id: string) => getEntry(id) }) }));

const LIST = {
    book: '96mid1ogzk',
    volumes: {
        '002': [
            { kind: 'span', at: '3:1:5', end: '3:1:6', sub: 'missing', old: '全總', new: '全書總', tv: '1.0.0', who: 'aaaaaa', ts: Date.UTC(2026, 9, 18) },
            { kind: 'span', at: '3:1:5', end: '3:1:6', sub: 'missing', old: '全總', note: '漏「書」', tv: '1.0.0', who: 'bbbbbb', ts: Date.UTC(2026, 9, 19) },
            { kind: 'char', at: '10:2:1', old: '日', new: '曰', who: 'aaaaaa', ts: 1 },
            { kind: 'entity', at: '4:4:5', end: '4:4:6', old: '王弼', note: '不是人名', who: 'cccccc' },
            { kind: 'char', at: 'bad', who: 'x' },
            { kind: 'nope', at: '1:1:1', who: 'x' },
        ],
        '003': [{ kind: 'char', at: '100:7:-1', new: '世', who: 'dddddd' }],
    },
    threads: {
        '002': { 'span~3:1:5~3:1:6~missing': { agree: 3, disagree: 1, replies: [{ name: '甲', text: '原书确有「書」', ts: Date.UTC(2026, 9, 19) }] } },
    },
};

const okFetch = (body: unknown, status = 200) => jest.fn().mockResolvedValue({ ok: status < 400, status, json: async () => body });
const COS_URL = 'https://data.kaiyuanguji.com/proof/fixes/96mid1ogzk.json';
/** 实时接口（/api/fixes）与 COS 兜底清单分开答 */
const routed = (live: unknown | null, cos: unknown = LIST, cosStatus = 200) => jest.fn(async (url: string) => {
    if (String(url).startsWith('/api/fixes')) return live === null ? { ok: false, status: 404, json: async () => null } : { ok: true, status: 200, json: async () => ({ success: true, ...(live as object) }) };
    return { ok: cosStatus < 400, status: cosStatus, json: async () => cos };
});

describe('lib/fixes', () => {
    it('解析：丢掉形状不对的；按处并组、数人数；按格位排（含抬头字 -1 格）', () => {
        const fixes = parsePublicFixes(LIST, '002');
        expect(fixes).toHaveLength(4);
        const groups = groupFixes(fixes);
        expect(groups.map((g) => `${g.kind}@${g.at}`)).toEqual(['span@3:1:5', 'entity@4:4:5', 'char@10:2:1']);
        expect(groups[0].people).toBe(2);
        expect(groups[0].items).toHaveLength(2);
        expect(parsePublicFixes(LIST, '003')[0].at).toBe('100:7:-1');
        expect(parsePublicFixes(LIST, '009')).toEqual([]);
        expect(parsePublicFixes(null, '002')).toEqual([]);
        expect(['2:1:1', '2:1:-1', '1:9:9'].sort(cellCompare)).toEqual(['1:9:9', '2:1:-1', '2:1:1']);
        expect(fixesPageHref('96mid1ogzk', '002')).toBe('/feedback/text?book=96mid1ogzk&vol=002');
    });
});

describe('TextFixesContent', () => {
    beforeEach(() => { search = 'book=96mid1ogzk&vol=002'; getEntry.mockReset().mockResolvedValue({ title: '四庫全書總目' }); });

    it('列出本册各处意见：位置链到阅读页该格，类别、原文、建议、人数、说明；可按类别筛', async () => {
        const fetchImpl = routed(LIST);
        await act(async () => { render(<TextFixesContent fetchImpl={fetchImpl as unknown as typeof fetch} />); });
        // 直读 KV：刚提的马上看到；有了实时结果就不用 COS 清单
        expect(fetchImpl.mock.calls[0][0]).toBe('/api/fixes?book=96mid1ogzk&volume=002');
        expect(fetchImpl).toHaveBeenCalledTimes(1);
        // 页头与校对页同一个：返回阅读、书名、状态标、第几册
        const header = screen.getByTestId('proofing-header');
        expect(within(header).getByRole('link', { name: /返回阅读/ })).toHaveAttribute('href', '/read/96mid1ogzk/002');
        expect(within(header).getByRole('heading', { level: 1 })).toHaveTextContent('四庫全書總目');
        expect(header).toHaveTextContent('读者反馈');
        expect(header).toHaveTextContent('第 002 册');
        expect(screen.getByText('共 3 处、4 条意见')).toBeInTheDocument();
        const rows = screen.getAllByTestId('fix-group');
        expect(rows).toHaveLength(3);
        const first = within(rows[0]);
        expect(first.getByRole('link')).toHaveAttribute('href', '/read/96mid1ogzk/002#3:1:5');
        expect(first.getByText('缺字（漏了字）')).toBeInTheDocument();
        expect(first.getByText('现作「全總」')).toBeInTheDocument();
        expect(first.getByText('应作「全書總」')).toBeInTheDocument();
        expect(first.getByText('2 人提出')).toBeInTheDocument();
        expect(first.getByText(/漏「書」/)).toBeInTheDocument();
        expect(within(rows[1]).getByText('专名「王弼」')).toBeInTheDocument();

        fireEvent.click(screen.getByRole('tab', { name: '改字' }));
        expect(screen.getAllByTestId('fix-group')).toHaveLength(1);
        fireEvent.click(screen.getByRole('tab', { name: '全部' }));
        expect(screen.getAllByTestId('fix-group')).toHaveLength(3);
    });

    it('讨论：显示计数与回复；表态、回复提交到 /api/thread，回复先在本页标「刚刚」显示（/api/fixes 是实时读，不再说「待汇总」）', async () => {
        const listFetch = jest.fn(async () => ({ ok: true, status: 200, json: async () => ({ success: true, ...LIST }) }));
        const postFetch = jest.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ success: true }) });
        const fetchImpl = jest.fn((url: string, init?: RequestInit) => (init?.method === 'POST' ? postFetch(url, init) : listFetch(url)));
        await act(async () => { render(<TextFixesContent fetchImpl={fetchImpl as unknown as typeof fetch} />); });
        const row = within(screen.getAllByTestId('fix-group')[0]);
        expect(row.getByText('同意 3 · 有不同看法 1')).toBeInTheDocument();
        expect(row.getByText('原书确有「書」')).toBeInTheDocument();
        // 别处没有讨论：计数为 0
        expect(within(screen.getAllByTestId('fix-group')[2]).getByText('同意 0 · 有不同看法 0')).toBeInTheDocument();

        await act(async () => { fireEvent.click(row.getByRole('button', { name: '同意' })); });
        expect(postFetch.mock.calls[0][0]).toBe('/api/thread');
        expect(JSON.parse(postFetch.mock.calls[0][1].body)).toMatchObject({ book_id: '96mid1ogzk', volume: '002', target: 'span~3:1:5~3:1:6~missing', stance: 'agree' });
        expect(row.getByRole('status')).toHaveTextContent('已记下您的看法，刷新本页即可看到计数。');
        expect(row.getByRole('status').textContent).not.toMatch(/次日|汇总/);
        expect(row.getByRole('button', { name: '同意' })).toHaveAttribute('aria-pressed', 'true');

        fireEvent.click(row.getByRole('button', { name: '回复' }));
        const submit = row.getByRole('button', { name: '发表' });
        expect(submit).toBeDisabled();
        fireEvent.change(row.getByLabelText('称呼'), { target: { value: '乙' } });
        fireEvent.change(row.getByLabelText('回复内容'), { target: { value: '书影第 3 页可证' } });
        await act(async () => { fireEvent.click(submit); });
        expect(JSON.parse(postFetch.mock.calls[1][1].body)).toMatchObject({ stance: 'reply', name: '乙', text: '书影第 3 页可证', target: 'span~3:1:5~3:1:6~missing' });
        expect(row.getByText('书影第 3 页可证')).toBeInTheDocument();
        expect(row.getByText('刚刚')).toBeInTheDocument();
        expect(row.queryByText('待汇总')).not.toBeInTheDocument();
        // 专名一处的 target
        const entRow = within(screen.getAllByTestId('fix-group')[1]);
        await act(async () => { fireEvent.click(entRow.getByRole('button', { name: '有不同看法' })); });
        expect(JSON.parse(postFetch.mock.calls[2][1].body).target).toBe('entity~4:4:5~4:4:6~');
    });

    it('整理组的处理结果：状态标（带版本、理由）与带「整理组」标的回复', async () => {
        const live = { ...LIST, threads: { '002': { 'span~3:1:5~3:1:6~missing': {
            agree: 0, disagree: 0,
            status: { state: 'adopted', version: '1.0.2', reason: '对过原书图' },
            replies: [{ name: '整理组', text: '已补「書」', team: true }, { name: '甲', text: '赞成' }],
        } } } };
        await act(async () => { render(<TextFixesContent fetchImpl={routed(live) as unknown as typeof fetch} />); });
        const row = within(screen.getAllByTestId('fix-group')[0]);
        expect(row.getByTestId('fix-status')).toHaveTextContent('已采纳');
        expect(row.getByTestId('fix-status')).toHaveTextContent('已进文本 1.0.2');
        expect(row.getByTestId('fix-status')).toHaveTextContent('对过原书图');
        expect(row.getAllByText('整理组')).toHaveLength(2); // 回复署名＋标
        expect(within(screen.getAllByTestId('fix-group')[1]).queryByTestId('fix-status')).toBeNull();
    });

    it('实时接口取不到时退回 COS 每日清单', async () => {
        const fetchImpl = routed(null);
        await act(async () => { render(<TextFixesContent fetchImpl={fetchImpl as unknown as typeof fetch} />); });
        expect(fetchImpl.mock.calls.map((c) => c[0])).toEqual(['/api/fixes?book=96mid1ogzk&volume=002', COS_URL]);
        expect(screen.getAllByTestId('fix-group')).toHaveLength(3);
    });

    it('实时与清单都没有＝还没有意见（清单 404）；都取不到＝提示稍后再试', async () => {
        await act(async () => { render(<TextFixesContent fetchImpl={routed(null, null, 404) as unknown as typeof fetch} />); });
        expect(screen.getByText('这一册还没有读者意见。')).toBeInTheDocument();
    });

    it('取失败', async () => {
        await act(async () => { render(<TextFixesContent fetchImpl={routed(null, null, 500) as unknown as typeof fetch} />); });
        expect(screen.getByRole('alert')).toHaveTextContent('暂时取不到');
    });

    it('取不到书名时页头只有状态标，页面照常', async () => {
        getEntry.mockRejectedValue(new Error('x'));
        await act(async () => { render(<TextFixesContent fetchImpl={routed(LIST) as unknown as typeof fetch} />); });
        expect(within(screen.getByTestId('proofing-header')).getByRole('heading', { level: 1 })).toHaveTextContent('读者反馈');
        expect(screen.getAllByTestId('fix-group')).toHaveLength(3);
    });

    it('缺参数', async () => {
        search = 'book=96mid1ogzk';
        const fetchImpl = routed(LIST);
        await act(async () => { render(<TextFixesContent fetchImpl={fetchImpl as unknown as typeof fetch} />); });
        expect(screen.getByRole('alert')).toHaveTextContent('地址缺书号或册号');
        expect(fetchImpl).not.toHaveBeenCalled();
    });
});
