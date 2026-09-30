/**
 * @jest-environment node
 *
 * indexer/lib/sort-fields.mjs —— 搜索页 v4「按年代」排序用的 era_rank（overview#298）
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let m: any;
beforeAll(async () => {
  m = await import('../../../../indexer/lib/sort-fields.mjs');
});

describe('eraRank', () => {
  test('按通行的朝代先后：先秦 < 漢 < 三國 < 晉 < 南北朝 < 隋 < 唐 < 宋 < 元 < 明 < 清', () => {
    const order = ['先秦', '漢', '三國', '晉', '南朝宋', '隋', '唐', '宋', '元', '明', '清'].map(m.eraRank);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(new Set(order).size).toBe(order.length);
  });

  test('同一朝代的细分排在总名之后、下一朝代之前（西漢／東漢在漢与三國之间，北宋／南宋在宋与元之间）', () => {
    expect(m.eraRank('漢')).toBeLessThan(m.eraRank('西漢'));
    expect(m.eraRank('西漢')).toBeLessThan(m.eraRank('東漢'));
    expect(m.eraRank('東漢')).toBeLessThan(m.eraRank('三國'));
    expect(m.eraRank('宋')).toBeLessThan(m.eraRank('北宋'));
    expect(m.eraRank('南宋')).toBeLessThan(m.eraRank('元'));
  });

  test('空、不认识、非字符串：垫底（升序排最后），不抛错；首尾空白忽略', () => {
    expect(m.eraRank('')).toBe(m.ERA_RANK_UNKNOWN);
    expect(m.eraRank('火星')).toBe(m.ERA_RANK_UNKNOWN);
    expect(m.eraRank(undefined)).toBe(m.ERA_RANK_UNKNOWN);
    expect(m.eraRank(null)).toBe(m.ERA_RANK_UNKNOWN);
    // 数据脏（数字、数组、对象）也不抛
    for (const bad of [0, 42, ['清'], { a: 1 }, true]) expect(m.eraRank(bad as never)).toBe(m.ERA_RANK_UNKNOWN);
    expect(m.eraRank(' 清 ')).toBe(m.eraRank('清'));
    expect(m.eraRank('清')).toBeLessThan(m.ERA_RANK_UNKNOWN);
  });

  test('与搜索页朝代分组（book-index-ui 的 DYNASTY_GROUPS）取值同源：分组里的每个取值都排得进序', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { DYNASTY_GROUPS } = require('book-index-ui');
    if (!DYNASTY_GROUPS) return; // 装的组件库还是不带搜索筛选的旧版（< 0.27.1）：升依赖后自动生效
    const missing = DYNASTY_GROUPS.flatMap((g: { values: string[] }) => g.values).filter((v: string) => m.eraRank(v) === m.ERA_RANK_UNKNOWN);
    expect(missing).toEqual([]);
  });
});

describe('sortTitle（title_sort 去前缀）', () => {
  test.each([
    ['1詩顯微論', '詩顯微論'],
    ['[寶慶]四明志', '四明志'],
    ['［道光］廣東通志', '廣東通志'],
    ['【清】某書', '某書'],
    ['〔民國〕某志', '某志'],
    ['[清][乾隆]某志', '某志'],
    ['［清］【乾隆】 某志', '某志'],
    ['12 [宋]某書', '某書'],
    ['[宋]1 某書', '某書'],
    ['易經', '易經'],
    ['四明[續]志', '四明[續]志'],
  ])('%s → %s', (input, expected) => {
    expect(m.sortTitle(input)).toBe(expected);
  });

  test('剥完为空则退回原题名；非字符串返回空串', () => {
    expect(m.sortTitle('[寶慶]')).toBe('[寶慶]');
    expect(m.sortTitle('123')).toBe('123');
    expect(m.sortTitle('［清］【乾隆】')).toBe('［清］【乾隆】');
    expect(m.sortTitle('')).toBe('');
    expect(m.sortTitle(undefined as never)).toBe('');
  });
});
