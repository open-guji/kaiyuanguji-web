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
};

const okFetch = (body: unknown, status = 200) => jest.fn().mockResolvedValue({ ok: status < 400, status, json: async () => body });

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
    beforeEach(() => { search = 'book=96mid1ogzk&vol=002'; });

    it('列出本册各处意见：位置链到阅读页该格，类别、原文、建议、人数、说明；可按类别筛', async () => {
        const fetchImpl = okFetch(LIST);
        await act(async () => { render(<TextFixesContent fetchImpl={fetchImpl as unknown as typeof fetch} />); });
        expect(fetchImpl.mock.calls[0][0]).toBe('https://data.kaiyuanguji.com/proof/fixes/96mid1ogzk.json');
        expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('第 002 册');
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

    it('清单 404＝还没有意见；取不到＝提示稍后再试；地址缺参数直说', async () => {
        await act(async () => { render(<TextFixesContent fetchImpl={okFetch(null, 404) as unknown as typeof fetch} />); });
        expect(screen.getByText('这一册还没有读者意见。')).toBeInTheDocument();
    });

    it('取失败', async () => {
        await act(async () => { render(<TextFixesContent fetchImpl={okFetch(null, 500) as unknown as typeof fetch} />); });
        expect(screen.getByRole('alert')).toHaveTextContent('暂时取不到');
    });

    it('缺参数', async () => {
        search = 'book=96mid1ogzk';
        const fetchImpl = okFetch(LIST);
        await act(async () => { render(<TextFixesContent fetchImpl={fetchImpl as unknown as typeof fetch} />); });
        expect(screen.getByRole('alert')).toHaveTextContent('地址缺书号或册号');
        expect(fetchImpl).not.toHaveBeenCalled();
    });
});
