/**
 * 后台「文本整理」：总览读 /api/text-progress 的快照，一册一行；各领域栏目各占一页，没填的留位置。
 */
import { render, screen, fireEvent, within } from '@testing-library/react';
import TextProgressView from '../TextProgressView';
import SectionView from '../SectionView';
import { resetTextProgressCache } from '../useTextProgress';

let mockSection = 'review';
jest.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(`s=${mockSection}`),
  usePathname: () => '/admin/text/section',
}));

const SNAP = {
  schema: 'text-progress/1',
  generated_at: new Date().toISOString(),
  collector: { at: new Date().toISOString(), problems: ['book-text x/default/index.json 取不到'] },
  volumes: [
    { book_id: '96mid1ogzk', vol: '001', book_title: '欽定四庫全書總目武英殿刻本', vol_title: '卷首', vol_order: 1, cv_book: 'vol01',
      text_version: '1.0.1', punct_version: '1.0.0', entity_version: '1.0.1', proofing: true, frozen_version: '1.0.0', pending_review: 0 },
    { book_id: '96mid1ogzk', vol: '006', book_title: '欽定四庫全書總目武英殿刻本', vol_title: '易類存目四', vol_order: 6, cv_book: 'vol06',
      text_version: '0.3.0', pending_review: 16, cells_total: 31234, pending_rev: '006-r5', pending_at: '2026-10-24T03:29:13Z',
      note: '等推库', field_meta: { note: { by: 'A32', at: '2026-10-25T04:00:00Z' }, pending_review: { by: 'web-collector' } } },
    { book_id: 'qtw-draft', vol: 'v006', book_title: '欽定全唐文', vol_title: '卷1~2', cv_book: 'v006' },
  ],
  sections: [
    { section: 'xingjin', title: '形近字', owner: 'A24', description: '形近字判别', sort: 10 },
    { section: 'review', title: '人审', owner: 'A32', description: '人审率等', sort: 30 },
  ],
  metrics: [
    { book_id: '96mid1ogzk', vol: '', section: 'review', key: 'human_rate', label: '人审率', value: 0.0135, unit: '%', writer: 'A32', at: '2026-10-25T04:00:00Z' },
  ],
};

function mockFetch(body: unknown, status = 200) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (global as any).fetch = jest.fn(async () => ({ status, json: async () => body }));
}

beforeEach(() => resetTextProgressCache());

describe('TextProgressView', () => {
  it('一册一行，按套书分组，带版本、待人审、待审单', async () => {
    mockFetch({ success: true, snapshot: SNAP });
    render(<TextProgressView />);
    expect(await screen.findByText('各册进度')).toBeInTheDocument();
    expect(screen.getByText('欽定四庫全書總目武英殿刻本')).toBeInTheDocument();
    expect(screen.getByText('欽定全唐文')).toBeInTheDocument();
    const row = screen.getByText('006-r5').closest('tr')!;
    expect(within(row).getByText('0.3.0')).toBeInTheDocument();
    expect(within(row).getByText('16')).toBeInTheDocument();
    // 采集直接数的待人审带 ≈ 和脚注
    expect(within(row).getByText('≈')).toBeInTheDocument();
    expect(screen.getByText(/带 ≈ 的待人审是线上待审单的原始格数/)).toBeInTheDocument();
    expect(within(row).getByText('精校')).toBeInTheDocument();
    expect(within(row).getByText('等推库')).toBeInTheDocument();
    const row1 = screen.getByText('卷首').closest('tr')!;
    expect(within(row1).getByText('已出 1.0')).toBeInTheDocument();
    expect(within(row1).getByText('冻结 1.0.0')).toBeInTheDocument();
    // 合计
    expect(screen.getByText('共 3 册')).toBeInTheDocument();
    // 采集提示
    expect(screen.getByText('book-text x/default/index.json 取不到')).toBeInTheDocument();
  });

  it('总览底部链到各栏目页，标出有没有数', async () => {
    mockFetch({ success: true, snapshot: SNAP });
    render(<TextProgressView />);
    await screen.findByText('整理过程数据');
    expect(screen.getByText('形近字').closest('a')).toHaveAttribute('href', '/admin/text/section?s=xingjin');
    expect(screen.getByText('A24 填 · 还没有数')).toBeInTheDocument();
    expect(screen.getByText('A32 填 · 1 项指标')).toBeInTheDocument();
  });

  it('筛选：只看有待人审的', async () => {
    mockFetch({ success: true, snapshot: SNAP });
    render(<TextProgressView />);
    await screen.findByText('各册进度');
    fireEvent.click(screen.getByLabelText('只看有待人审的'));
    expect(screen.queryByText('卷首')).not.toBeInTheDocument();
    expect(screen.queryByText('欽定全唐文')).not.toBeInTheDocument();
    expect(screen.getByText('006-r5')).toBeInTheDocument();
  });

  it('按阶段筛选', async () => {
    mockFetch({ success: true, snapshot: SNAP });
    render(<TextProgressView />);
    await screen.findByText('各册进度');
    fireEvent.click(within(screen.getByRole('radiogroup', { name: '按阶段筛选' })).getByRole('radio', { name: '已出 1.0' }));
    expect(screen.getByText('卷首')).toBeInTheDocument();
    expect(screen.queryByText('006-r5')).not.toBeInTheDocument();
  });

  it('还没有快照', async () => {
    mockFetch({ success: true, snapshot: null });
    render(<TextProgressView />);
    expect(await screen.findByText(/还没有数据/)).toBeInTheDocument();
  });

  it('取数失败', async () => {
    mockFetch({ success: false, error: '未授权' }, 401);
    render(<TextProgressView />);
    expect(await screen.findByText('取数失败：未授权')).toBeInTheDocument();
  });
});

describe('SectionView', () => {
  it('有数的栏目：整套的数做成卡片，各册的数排成表', async () => {
    mockSection = 'review';
    mockFetch({ success: true, snapshot: { ...SNAP, metrics: [
      ...SNAP.metrics,
      { book_id: '96mid1ogzk', vol: '006', section: 'review', key: 'judged', label: '已裁格数', value: 1234, writer: 'A32', at: '2026-10-25T04:00:00Z' },
    ] } });
    render(<SectionView />);
    expect(await screen.findByText('1.35%')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '人审' })).toBeInTheDocument();
    const row = screen.getByText('1,234').closest('tr')!;
    expect(within(row).getByText('006')).toBeInTheDocument();
    expect(within(row).getByText('易類存目四')).toBeInTheDocument();
  });

  it('没数的栏目留位置，写明谁填、怎么写', async () => {
    mockSection = 'xingjin';
    mockFetch({ success: true, snapshot: SNAP });
    render(<SectionView />);
    expect(await screen.findByText('还没有数')).toBeInTheDocument();
    expect(screen.getByText(/这一栏留给 A24 填/)).toBeInTheDocument();
  });

  it('快照还没有：仍按预置栏目显示标题', async () => {
    mockSection = 'yiti';
    mockFetch({ success: true, snapshot: null });
    render(<SectionView />);
    expect(await screen.findByText(/还没有数据/)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '异体字组' })).toBeInTheDocument();
  });

  it('不认识的栏目', async () => {
    mockSection = 'nope';
    mockFetch({ success: true, snapshot: SNAP });
    render(<SectionView />);
    expect(await screen.findByText('没有这个栏目')).toBeInTheDocument();
  });
});
