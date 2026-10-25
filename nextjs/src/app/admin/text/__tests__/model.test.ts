import { ago, fmtLA, fmtMetric, groupByBook, isStale, majorOf, scopeOf, stageOf, writersOf, type VolumeRow } from '../model';

const v = (o: Partial<VolumeRow>): VolumeRow => ({ book_id: 'b', vol: '001', ...o });

describe('stageOf', () => {
  it('领域写了 stage 就用它', () => {
    expect(stageOf(v({ stage: 'pipeline', text_version: '1.0.0' }))).toEqual({ stage: 'pipeline', derived: false });
  });
  it('按文本版本推断：0.x 精校、≥1 已出 1.0', () => {
    expect(stageOf(v({ text_version: '0.1.0' }))).toEqual({ stage: 'fine', derived: true });
    expect(stageOf(v({ text_version: '1.0.3' }))).toEqual({ stage: 'released', derived: true });
  });
  it('没有文本：有 cv 册算粗校，否则未开工', () => {
    expect(stageOf(v({ cv_book: 'vol11' })).stage).toBe('rough');
    expect(stageOf(v({})).stage).toBe('todo');
  });
  it('不认识的 stage 当没写', () => {
    expect(stageOf(v({ stage: 'weird' as never, text_version: '0.2.0' })).stage).toBe('fine');
  });
});

describe('majorOf', () => {
  it('只认 x.y.z', () => {
    expect(majorOf('2.0.1')).toBe(2);
    expect(majorOf('v1')).toBeNull();
    expect(majorOf(null)).toBeNull();
  });
});

describe('groupByBook', () => {
  it('按套书分组（册多的在前）、组内按 vol_order 排、合计待人审', () => {
    const g = groupByBook([
      v({ book_id: 'x', vol: '010', vol_order: 10, pending_review: 5, text_version: '0.1.0', book_title: '乙书' }),
      v({ book_id: 'x', vol: '002', vol_order: 2, pending_review: 1, text_version: '1.0.0' }),
      v({ book_id: 'a', vol: 'v006', book_title: '甲书' }),
    ]);
    expect(g.map((x) => x.book_id)).toEqual(['x', 'a']);
    const x = g[0];
    expect(x.title).toBe('乙书');
    expect(x.volumes.map((r) => r.vol)).toEqual(['002', '010']);
    expect(x.pending).toBe(6);
    expect(x.stages).toEqual({ fine: 1, released: 1 });
  });
});

describe('格式', () => {
  it('洛杉矶时间', () => {
    expect(fmtLA('2026-10-25T04:11:10Z')).toBe('10-24 21:11');
    expect(fmtLA('2026-10-25T04:11:10Z', true)).toBe('2026-10-24 21:11');
    expect(fmtLA(null)).toBe('—');
  });
  it('距今', () => {
    const now = Date.parse('2026-10-25T05:00:00Z');
    expect(ago('2026-10-25T04:59:30Z', now)).toBe('刚刚');
    expect(ago('2026-10-25T04:30:00Z', now)).toBe('30 分钟前');
    expect(ago('2026-10-25T01:00:00Z', now)).toBe('4 小时前');
    expect(ago('2026-10-20T05:00:00Z', now)).toBe('5 天前');
    expect(isStale('2026-10-25T01:00:00Z', now)).toBe(false);
    expect(isStale('2026-10-24T20:00:00Z', now)).toBe(true);
    expect(isStale(undefined, now)).toBe(true);
  });
  it('指标值', () => {
    expect(fmtMetric({ value: 0.973, unit: '%' })).toBe('97.3%');
    expect(fmtMetric({ value: 0.0135, unit: '%' })).toBe('1.35%');
    expect(fmtMetric({ value: 1234, unit: '格' })).toBe('1,234 格');
    expect(fmtMetric({ value: null, value_text: '试跑中' })).toBe('试跑中');
    expect(fmtMetric({})).toBe('—');
  });
  it('范围与写入方', () => {
    const t = new Map([['b', '某书']]);
    expect(scopeOf({ book_id: '', vol: '' }, t)).toBe('全部');
    expect(scopeOf({ book_id: 'b', vol: '' }, t)).toBe('某书（整套）');
    expect(scopeOf({ book_id: 'b', vol: '005' }, t)).toBe('某书 · 005');
    expect(writersOf(v({ field_meta: { a: { by: 'web-collector' }, b: { by: 'A32' }, c: { by: 'A32' } } }))).toEqual(['A32', 'web-collector']);
  });
});
