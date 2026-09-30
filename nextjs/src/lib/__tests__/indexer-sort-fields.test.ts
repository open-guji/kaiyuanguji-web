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
