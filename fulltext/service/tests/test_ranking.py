import ranking
from ranking import group_and_rank


def h(entry, chapter, start, score=1.0, chapter_len=1000):
    return {'entry': entry, 'chapter': chapter, 'start': start, 'score': score, 'chapter_len': chapter_len}


def test_short_chapter_is_demoted_to_0_3():
    short = h('A', '001', 0, score=1.0, chapter_len=29)
    assert ranking.seg_score(short, {}) == 0.3


def test_chapter_of_exactly_30_chars_is_not_demoted():
    assert ranking.seg_score(h('A', '001', 0, chapter_len=30), {}) == 1.0


def test_short_chapter_loses_to_long_chapter_with_lower_raw_score():
    hits = [h('S', '001', 0, score=1.0, chapter_len=10), h('L', '001', 0, score=0.5)]
    assert [g['entry'] for g in group_and_rank(hits)] == ['L', 'S']


def test_boost_multiplies_segment_score_and_defaults_to_one():
    hits = [h('A', '001', 0, score=1.0), h('B', '001', 0, score=1.5)]
    assert [g['entry'] for g in group_and_rank(hits)] == ['B', 'A']
    assert [g['entry'] for g in group_and_rank(hits, {'A': 2.0})] == ['A', 'B']


def test_book_score_adds_log_bonus_for_more_hits():
    # 两书最高段分相同；命中段多的书应排前
    one = [h('A', '001', 0, score=1.0)]
    many = [h('B', '001', 0, score=1.0), h('B', '002', 0, score=0.9), h('B', '003', 0, score=0.9)]
    ranked = group_and_rank(one + many)
    assert [g['entry'] for g in ranked] == ['B', 'A']
    bonus = 0.1 * ranking.math.log1p(3)
    assert abs(ranked[0]['score'] - (1.0 + bonus)) < 1e-9


def test_within_book_sorted_by_chapter_then_start_regardless_of_score():
    hits = [h('A', '002', 5, score=9.0), h('A', '001', 30, score=0.1), h('A', '001', 2, score=0.2)]
    g = group_and_rank(hits)[0]
    assert [(x['chapter'], x['start']) for x in g['hits']] == [('001', 2), ('001', 30), ('002', 5)]


def test_hit_count_counts_all_hits_of_book():
    hits = [h('A', '001', i) for i in range(7)]
    g = group_and_rank(hits)[0]
    assert g['hit_count'] == 7 and len(g['hits']) == 7


def test_empty_input_returns_empty():
    assert group_and_rank([]) == []


def test_ties_keep_candidate_order():
    hits = [h('X', '001', 0), h('Y', '001', 0), h('Z', '001', 0)]
    assert [g['entry'] for g in group_and_rank(hits)] == ['X', 'Y', 'Z']


def test_hits_do_not_leak_across_books():
    hits = [h('A', '001', 0), h('B', '001', 0), h('A', '002', 0)]
    by = {g['entry']: g for g in group_and_rank(hits)}
    assert by['A']['hit_count'] == 2 and by['B']['hit_count'] == 1
