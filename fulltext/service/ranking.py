"""F4 排序（步 2）：纯函数，不依赖索引与 Tantivy。规则见 分块-F4-Eden.md §三。

1. 段分 = 候选分 × boost[entry]（boost 缺省 1.0；常用书名单默认空表）
2. 短章降权：所在章总长 < 30 字，段分 × 0.3（解决"短章标题排前面"）
3. 书分 = 该书段分最高值 + 0.1 × log(1 + 命中段数)
4. 书间按书分降序（同分保持候选出现顺序）；书内按 (chapter, start) 升序
"""
import math

SHORT_CHAPTER = 30
SHORT_FACTOR = 0.3
HIT_BONUS = 0.1


def seg_score(hit, boost):
    s = hit['score'] * boost.get(hit['entry'], 1.0)
    if hit['chapter_len'] < SHORT_CHAPTER:
        s *= SHORT_FACTOR
    return s


def group_and_rank(hits, boost=None):
    """hits：每项至少含 entry, chapter, start, score, chapter_len（命中段已定位）。
    返回 [{'entry', 'score', 'hit_count', 'hits'}]，hits 为书内全部命中（未截 per_book）。"""
    boost = boost or {}
    by_book = {}
    order = []
    for h in hits:
        e = h['entry']
        if e not in by_book:
            by_book[e] = {'entry': e, 'score': 0.0, 'hit_count': 0, 'hits': []}
            order.append(e)
        g = by_book[e]
        g['hit_count'] += 1
        g['score'] = max(g['score'], seg_score(h, boost))
        g['hits'].append(h)
    for g in by_book.values():
        g['score'] += HIT_BONUS * math.log1p(g['hit_count'])
        g['hits'].sort(key=lambda h: (h['chapter'], h['start']))
    # sorted 稳定：同分保持候选出现顺序
    return sorted((by_book[e] for e in order), key=lambda g: -g['score'])
