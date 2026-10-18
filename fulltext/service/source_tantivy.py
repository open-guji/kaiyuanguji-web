"""真 Tantivy 候选来源（F4 步 4）：读 F2 索引包（build/build_pack.py 产出）。

索引 schema 见 build/build_pack.py build_schema()：
- norm／orig：双字带位置（whitespace 分词，空格分隔的二字组）；
- norm1／orig1：单字只记频次；
- entry／label／chapter／start／end：存储字段。

候选规则：needle 长 1 → 查 norm1／orig1 的单字；长 2 → 单个二字组 term；长 ≥3 → 二字组 phrase（连续位置）。
候选是超集，最终命中由 Service 的 locate() 逐段确认，所以这里多给不会出错，漏给才会。
"""
import json
import os
import threading
import time
from collections import OrderedDict

import tantivy

from app import IndexUnavailable


def _bigrams(s):
    return [s[i:i + 2] for i in range(len(s) - 1)]


class ChapterCache:
    """章 md 的 LRU，按字节计上限（步 3）。线程安全。"""

    def __init__(self, max_bytes):
        self.max_bytes = max_bytes
        self.size = 0
        self._d = OrderedDict()
        self._lock = threading.Lock()

    def get(self, key, loader):
        with self._lock:
            if key in self._d:
                self._d.move_to_end(key)
                return self._d[key]
        text = loader()
        n = len(text.encode('utf-8'))
        with self._lock:
            if key not in self._d:
                self._d[key] = text
                self.size += n
                while self.size > self.max_bytes and len(self._d) > 1:
                    _, old = self._d.popitem(last=False)
                    self.size -= len(old.encode('utf-8'))
            return self._d[key]

    def clear(self):
        with self._lock:
            self._d.clear()
            self.size = 0


class TantivySource:
    def __init__(self, index_dir, text_root, titles, lru_bytes=64 * 1024 * 1024):
        self.index_dir = index_dir
        self.text_root = text_root
        self.titles = titles
        self.cache = ChapterCache(lru_bytes)
        self._open()

    def _open(self):
        try:
            self.index = tantivy.Index.open(self.index_dir)
        except Exception as e:  # 目录不存在、损坏、版本不符
            raise IndexUnavailable(str(e))
        self.index.reload()
        self.searcher = self.index.searcher()

    def prefetch_index(self):
        """启动预热第一步：把索引目录的文件页预读进 OS 缓存（posix_fadvise WILLNEED，无此接口则整读一遍）。
        返回 (读入字节数, 耗时秒)。只读页缓存，不改索引。"""
        t0 = time.monotonic()
        total = 0
        for name in sorted(os.listdir(self.index_dir)):
            p = os.path.join(self.index_dir, name)
            if not os.path.isfile(p):
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
        self.cache.clear()
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

    def _book_dir(self, entry):
        t = entry[-3:]
        for top in ('Book', 'Work'):
            d = os.path.join(self.text_root, top, t[0], t[1], t[2], entry)
            if os.path.isdir(d):
                return d
        raise FileNotFoundError(f'book-text 缺失: {entry}')

    def chapter_text(self, entry, chapter):
        key = (entry, chapter)

        def load():
            p = os.path.join(self._book_dir(entry), 'default', chapter + '.md')
            with open(p, encoding='utf-8') as f:
                return f.read()

        return self.cache.get(key, load)

    def _query(self, needle, field):
        sch = self.index.schema
        if len(needle) == 1:
            return tantivy.Query.term_query(sch, field + '1', needle)
        grams = _bigrams(needle)
        if len(grams) == 1:
            return tantivy.Query.term_query(sch, field, grams[0])
        return tantivy.Query.phrase_query(sch, field, grams, 0)

    def candidates(self, needle, field, entry, k):
        q = self._query(needle, field)
        limit = k if k is not None else max(1, self.searcher.num_docs)
        result = self.searcher.search(q, limit=limit)
        out = []
        for _, addr in result.hits:
            d = self.searcher.doc(addr)
            e = d.get_first('entry')
            if entry and e != entry:
                continue
            out.append({
                'entry': e,
                'chapter': d.get_first('chapter'),
                'label': d.get_first('label'),
                'start': d.get_first('start'),
                'end': d.get_first('end'),
                'score': 1.0,
            })
        return out
