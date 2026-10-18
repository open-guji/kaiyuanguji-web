import math

from ranking import book_score, rank_books


def b(entry, count=1, long=True):
    return {'entry': entry, 'count': count, 'long': long}


def test_book_only_hit_in_short_chapters_is_demoted():
    assert abs(book_score(b('A', 1, long=False), {}) - (0.3 + 0.1 * math.log1p(1))) < 1e-9


def test_short_chapter_book_loses_to_long_chapter_book_with_fewer_hits():
    assert [x['entry'] for x in rank_books([b('S', 5, long=False), b('L', 1)])] == ['L', 'S']


def test_boost_multiplies_and_defaults_to_one():
    assert [x['entry'] for x in rank_books([b('A'), b('B', 2)])] == ['B', 'A']
    assert [x['entry'] for x in rank_books([b('A'), b('B', 2)], {'A': 2.0})] == ['A', 'B']


def test_more_hits_rank_higher_with_log_bonus():
    r = rank_books([b('A', 1), b('B', 3)])
    assert [x['entry'] for x in r] == ['B', 'A']
    assert abs(r[0]['score'] - (1.0 + 0.1 * math.log1p(3))) < 1e-9


def test_ties_broken_by_entry_for_stable_order():
    assert [x['entry'] for x in rank_books([b('Z'), b('X'), b('Y')])] == ['X', 'Y', 'Z']


def test_empty_input_returns_empty():
    assert rank_books([]) == []


def test_input_not_mutated():
    src = [b('A')]
    rank_books(src)
    assert 'score' not in src[0]
