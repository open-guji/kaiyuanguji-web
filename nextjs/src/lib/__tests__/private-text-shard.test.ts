import { hashShard, pathShardSegments } from '../private-text-shard';

describe('hashShard', () => {
  // 与 overview scripts/book-text/build_index.py 的 shard() 对拍出来的已知值：
  // book-text-private 里 d59ezak6jq4g 实测落在 index/full_text/9.json。
  it('与 build_index.py 的 shard() 结果一致（已知样本）', () => {
    expect(hashShard('d59ezak6jq4g')).toBe('9');
  });

  it('结果恒为单个十六进制字符', () => {
    for (const id of ['a', 'd59f2ofu9i4i', '0000000000000000']) {
      expect(hashShard(id)).toMatch(/^[0-9a-f]$/);
    }
  });
});

describe('pathShardSegments', () => {
  it('取 id 尾三字元，顺序不翻转', () => {
    expect(pathShardSegments('d59ezak6jq4g')).toEqual(['q', '4', 'g']);
  });

  it('短于三字元时左侧补齐（边界情形，实际 id 不会这么短）', () => {
    expect(pathShardSegments('ab')).toEqual(['_', 'a', 'b']);
  });
});
