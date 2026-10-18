"""书间排序（v2）：纯函数，不依赖索引。输入是按书聚合的结果，不再逐段算分。

书分 = boost[entry] × 章长系数 + 0.1 × log(1 + 命中段数)
- boost 缺省 1.0（常用书名单 boost.json，默认空表）；
- 章长系数：该书至少有一段命中落在 ≥30 字的章 → 1.0；全部落在短章 → 0.3（压住"只命中章标题"的书）；
- 同分按命中段数降序，再按 entry 升序（结果稳定、可复现）。
书内顺序由索引的 ord 字段保证（原文顺序），这里不管。
"""
import math

SHORT_CHAPTER = 30      # 与 build/build_pack.py 同值
SHORT_FACTOR = 0.3
HIT_BONUS = 0.1


def book_score(b, boost):
    base = boost.get(b['entry'], 1.0) * (1.0 if b['long'] else SHORT_FACTOR)
    return base + HIT_BONUS * math.log1p(b['count'])


def rank_books(buckets, boost=None):
    """buckets：[{'entry', 'count', 'long'}]。返回同样的字典（加 'score'），按书分降序。"""
    boost = boost or {}
    out = [dict(b, score=book_score(b, boost)) for b in buckets]
    out.sort(key=lambda b: (-b['score'], -b['count'], b['entry']))
    return out
