/**
 * @jest-environment node
 *
 * indexer/lib/work-fields.mjs —— works 索引新增的 classification（部）与 loss_status（存佚）取值
 * （overview#291 P1a）。full-reindex.mjs 一 import 就跑 main，所以取值逻辑单独成模块在这里测。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let m: any;
beforeAll(async () => {
  m = await import('../../../../indexer/lib/work-fields.mjs');
});

describe('classificationL1', () => {
  test('取 classification.l1，去首尾空白，保持繁体原文', () => {
    expect(m.classificationL1({ l1: '史部', l2: '正史類' })).toBe('史部');
    expect(m.classificationL1({ l1: ' 經部 ' })).toBe('經部');
  });
  test('没有 l1、l1 为空／非字符串、没有 classification：空串', () => {
    expect(m.classificationL1({ l1: '', l2: '正史類' })).toBe('');
    expect(m.classificationL1({ l1: '   ' })).toBe('');
    expect(m.classificationL1({ l1: 3 })).toBe('');
    expect(m.classificationL1({})).toBe('');
    expect(m.classificationL1(undefined)).toBe('');
    expect(m.classificationL1(null, 'x')).toBe('');
    expect(m.classificationL1()).toBe('');
  });
  test('多个来源：详情优先，缺则用分片行', () => {
    expect(m.classificationL1({ l1: '子部' }, { l1: '集部' })).toBe('子部');
    expect(m.classificationL1(undefined, { l1: '集部' })).toBe('集部');
    expect(m.classificationL1({ l1: '' }, { l1: '集部' })).toBe('集部');
  });
});

describe('lossStatusValue', () => {
  test('只认 extant／partially_extant／lost', () => {
    expect(m.lossStatusValue('extant')).toBe('extant');
    expect(m.lossStatusValue('partially_extant')).toBe('partially_extant');
    expect(m.lossStatusValue('lost')).toBe('lost');
  });
  test('别的值、缺失、非字符串：空串；多个来源取第一个合法的', () => {
    expect(m.lossStatusValue('unknown')).toBe('');
    expect(m.lossStatusValue('')).toBe('');
    expect(m.lossStatusValue(undefined)).toBe('');
    expect(m.lossStatusValue(1)).toBe('');
    expect(m.lossStatusValue(undefined, 'lost')).toBe('lost');
    expect(m.lossStatusValue('bogus', 'extant')).toBe('extant');
  });
});
