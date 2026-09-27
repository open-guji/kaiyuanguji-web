/**
 * 私有文本仓（book-text-private）两套分片算法的前端实现——只用在 /admin/private-text
 * 调试页，定位一个 id 该去哪个索引分片、哪个目录。两套都不是发明的，是照抄既有实现：
 *
 *   - hashShard：index/full_text/{0-f}.json 等索引分片的雜湊法，
 *     与 overview `scripts/book-text/build_index.py` 的 `shard()` 逐字节等价
 *     （h = (h*31 + charCode) mod 2^32，取 h%16 的十六进制个位）。
 *   - pathShardSegments：Work/Book 数据目录本身的分片，取 id **尾三字元**，
 *     与 book-text-private README「目录与格式」一致，跟上面那套雜湊法不是一回事。
 */

export function hashShard(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i += 1) {
    h = (h * 31 + id.charCodeAt(i)) % 4294967296; // 2**32，等价于逐步 & 0xFFFFFFFF
  }
  return (h % 16).toString(16);
}

export function pathShardSegments(id: string): [string, string, string] {
  const tail = id.length >= 3 ? id.slice(-3) : id.padStart(3, '_');
  return [tail[0], tail[1], tail[2]];
}
