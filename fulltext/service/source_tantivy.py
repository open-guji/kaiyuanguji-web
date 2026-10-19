"""Tantivy 检索来源（v2）：读 build/build_pack.py 产出的索引包，不读 book-text。

索引字段见 build_pack.build_schema()：norm（双字带位置）、norm1（单字频次）、entry（快字段）、
ord（书内段序，快字段）、long（所在章 ≥30 字）、chapter／label／start／end／text（存储）。

查询规则：needle 长 1 → norm1 单字 term；长 2 → 一个双字 term；长 ≥3 → 双字 phrase（相邻位置）。
双字词元覆盖整段字流，所以 norm 层的 phrase 命中＝段内字流含该串，计数是准的；
exact 模式在 app 层对存储的原文再筛一遍。
"""
import json
import os
import time

import tantivy

import common

from app import IndexUnavailable

BIG_LIMIT = 10000          # 超过这个 limit 先计数再取
MAX_BOOKS = 50000          # 按书聚合的桶数上限（全库约 9 千部）
REQUIRED_FIELDS = ('norm', 'norm1', 'entry', 'ord', 'long', 'text')
PREFETCH_SKIP = ('.store',)  # 原文存储块不预读（全量约 1 GB，按需读）


def _bigrams(s):
    return [s[i:i + 2] for i in range(len(s) - 1)]


class TantivySource:
    def __init__(self, index_dir, titles):
        self.index_dir = index_dir
        self.titles = titles
        self._open()

    def _open(self):
        try:
            index = tantivy.Index.open(self.index_dir)
        except Exception as e:  # 目录不存在、损坏、版本不符
            raise IndexUnavailable(str(e))
        index.reload()
        searcher = index.searcher()
        missing = [f for f in REQUIRED_FIELDS if not _has_field(index, f)]
        if missing:
            raise IndexUnavailable(f'索引不是 v2 格式，缺字段 {missing}（需用新 build_pack 重建）')
        self.index, self.searcher = index, searcher
        self._load_charmap()

    def _load_charmap(self):
        """包里带 charmap.json 就按它归一查询（建索引用的就是这张表）；旧包没有则沿用代码自带的。"""
        p = os.path.join(os.path.dirname(self.index_dir.rstrip('/')), 'charmap.json')
        if not os.path.isfile(p):
            return
        try:
            with open(p, encoding='utf-8') as f:
                m = json.load(f)
        except (OSError, ValueError) as e:
            raise IndexUnavailable(f'包里的 charmap.json 读不了：{e}')
        if m != common.CMAP:
            common.set_charmap(m)

    def prefetch_index(self):
        """启动预热：倒排、位置、快字段文件预读进 OS 缓存（posix_fadvise WILLNEED）；原文存储块不预读。
        返回 (读入字节数, 耗时秒)。"""
        t0 = time.monotonic()
        total = 0
        for name in sorted(os.listdir(self.index_dir)):
            p = os.path.join(self.index_dir, name)
            if not os.path.isfile(p) or name.endswith(PREFETCH_SKIP):
                continue
            with open(p, 'rb') as f:
                size = os.fstat(f.fileno()).st_size
                if hasattr(os, 'posix_fadvise'):
                    os.posix_fadvise(f.fileno(), 0, 0, os.POSIX_FADV_WILLNEED)
                else:
                    while f.read(1 << 20):
                        pass
            total += size
        return total, time.monotonic() - t0

    def reload(self):
        self._open()
        return self.stamp()

    def stamp(self):
        p = os.path.join(os.path.dirname(self.index_dir.rstrip('/')), 'manifest.json')
        try:
            with open(p, encoding='utf-8') as f:
                return json.load(f).get('stamp')
        except (OSError, ValueError):
            return None

    def book_title(self, entry):
        return self.titles.get(entry, entry)

    # ---- 查询 ----
    def _query(self, needle, entry=None):
        sch = self.index.schema
        if len(needle) == 1:
            q = tantivy.Query.term_query(sch, 'norm1', needle)
        else:
            grams = _bigrams(needle)
            q = (tantivy.Query.term_query(sch, 'norm', grams[0]) if len(grams) == 1
                 else tantivy.Query.phrase_query(sch, 'norm', grams, 0))
        if entry:
            q = tantivy.Query.boolean_query([
                (tantivy.Occur.Must, q),
                (tantivy.Occur.Must, tantivy.Query.term_query(sch, 'entry', entry)),
            ])
        return q

    def _near_query(self, needle, entry=None):
        """差一字召回（near 模式）：少一字的各个串，加上中间多一字／错一字时左右两半按位置拼的 phrase，取并集。
        一边只剩一个字时那边没有双字词元，只按另一边召回（宽一些，app 层再用正则核）。"""
        sch = self.index.schema
        n = len(needle)
        shapes = set()
        for i in range(n):                                   # 少一字
            shapes.add(tuple(enumerate(_bigrams(needle[:i] + needle[i + 1:]))))
        for k in range(1, n):                                # 多一字：右半往后挪一位
            shapes.add(tuple(list(enumerate(_bigrams(needle[:k])))
                             + [(k + 1 + j, g) for j, g in enumerate(_bigrams(needle[k:]))]))
        for i in range(1, n - 1):                            # 错一字：右半位置不变，中间空一位
            shapes.add(tuple(list(enumerate(_bigrams(needle[:i])))
                             + [(i + 1 + j, g) for j, g in enumerate(_bigrams(needle[i + 1:]))]))
        subs = []
        for toks in shapes:
            if not toks:
                continue
            if len(toks) == 1:
                subs.append((tantivy.Occur.Should, tantivy.Query.term_query(sch, 'norm', toks[0][1])))
            else:
                base = toks[0][0]
                subs.append((tantivy.Occur.Should, tantivy.Query.phrase_query(
                    sch, 'norm', [(p - base, g) for p, g in toks], 0)))
        q = tantivy.Query.boolean_query(subs)
        if entry:
            q = tantivy.Query.boolean_query([
                (tantivy.Occur.Must, q),
                (tantivy.Occur.Must, tantivy.Query.term_query(sch, 'entry', entry)),
            ])
        return q

    def count(self, needle, entry=None):
        return self.searcher.search(self._query(needle, entry), 1, count=True).count

    def book_counts(self, needle, entry=None):
        """按书聚合：[{entry, count, long}]（long＝该书有命中落在 ≥30 字的章），以及是否超桶数上限。"""
        agg = self.searcher.aggregate(self._query(needle, entry), {
            'by': {'terms': {'field': 'entry', 'size': MAX_BOOKS},
                   'aggs': {'long': {'max': {'field': 'long'}}}}})
        buckets = agg['by']['buckets']
        out = [{'entry': b['key'], 'count': b['doc_count'], 'long': bool((b['long'] or {}).get('value'))}
               for b in buckets]
        return out, len(buckets) >= MAX_BOOKS

    def passages(self, needle, entry=None, limit=10, offset=0, in_order=True, near=False):
        """命中段（含原文）。in_order：按 ord 升序（同一部书内即原文顺序）；否则按相关度。
        near：按差一字召回（候选，app 层再核）。返回 (段列表, 命中总数)。"""
        q = self._near_query(needle, entry) if near else self._query(needle, entry)
        if limit > BIG_LIMIT:   # Tantivy 按 limit 预分配结果堆，超大 limit（评测取全集）先数一遍
            limit = max(1, min(limit, self.searcher.search(q, 1, count=True).count))
        if in_order:
            res = self.searcher.search(q, limit, count=True, order_by_field='ord',
                                       offset=offset, order=tantivy.Order.Asc)
        else:
            res = self.searcher.search(q, limit, count=True, offset=offset)
        out = []
        for _, addr in res.hits:
            d = self.searcher.doc(addr)
            out.append({
                'entry': d.get_first('entry'),
                'chapter': d.get_first('chapter'),
                'label': d.get_first('label'),
                'start': d.get_first('start'),
                'end': d.get_first('end'),
                'long': bool(d.get_first('long')),
                'text': d.get_first('text').decode('utf-8'),
            })
        return out, res.count


def _has_field(index, name):
    """tantivy-py 的 Schema 不给字段列表；用 parse_query 探测：未定义的字段报 "not defined"，
    已定义但不索引的字段报 "not set as indexed"（也算有）。"""
    try:
        index.parse_query(f'{name}:x', [name])
        return True
    except ValueError as e:
        return 'not defined' not in str(e)
