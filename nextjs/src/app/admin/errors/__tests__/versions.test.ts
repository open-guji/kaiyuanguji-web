import { groupByVersion, versionKey, versionOf } from '../versions';

describe('错误按版本归并（DBG）', () => {
  const A = 'a'.repeat(40);
  const B = 'b'.repeat(40);

  it('按 (代码, 数据) 分组、组内列最多的错误、组按条数降序', () => {
    const g = groupByVersion([
      { kind: 'js', message: 'x is undefined', web: A, data: 'd1' },
      { kind: 'js', message: 'x is undefined', web: A, data: 'd1' },
      { kind: 'fetch', message: 'entry 不存在 (404)', web: A, data: 'd1' },
      { kind: 'js', message: 'y', web: B, data: 'd1' },
    ]);
    expect(g.map((x) => [x.web, x.data, x.count])).toEqual([
      ['aaaaaaaaaaaa', 'd1', 3],
      ['bbbbbbbbbbbb', 'd1', 1],
    ]);
    expect(g[0].top[0]).toEqual({ kind: 'js', message: 'x is undefined', count: 2 });
  });

  it('同一代码、不同数据版本分开计', () => {
    const g = groupByVersion([
      { kind: 'js', message: 'm', web: A, data: 'd1' },
      { kind: 'js', message: 'm', web: A, data: 'd2' },
    ]);
    expect(g).toHaveLength(2);
  });

  it('DBG 之前的老记录：只有 release（=数据版本），代码版本记为未知', () => {
    const old = { kind: 'js', message: 'm', release: 'd0' };
    expect(versionOf(old)).toEqual({ web: '', data: 'd0' });
    expect(versionKey(old)).toBe('|d0');
    expect(groupByVersion([old])[0]).toMatchObject({ web: '', data: 'd0', count: 1 });
  });
});
