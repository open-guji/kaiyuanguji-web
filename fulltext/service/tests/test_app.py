import json
import threading
import urllib.parse
import urllib.request
from http.server import ThreadingHTTPServer

import pytest

import app
from fakes import SAMPLE, FakeSource

# F1 响应字段表（docs/design.md「接口」一节；样例 contract/sample_response.json）。
F1_TOP = {'q', 'mode', 'normalized', 'truncated', 'total_books', 'total_books_capped',
          'has_more', 'total_hits', 'capped', 'groups', 'took_ms'}
F1_GROUP = {'entry', 'title', 'hit_count', 'hits'}
F1_HIT = {'chapter', 'label', 'matches', 'snippet'}


_SRC = {}


def svc(books=SAMPLE, exact_scan=3000):
    key = id(books)
    if key not in _SRC:
        _SRC[key] = (books, FakeSource(books))   # 留住 books，免得 id 被复用
    return app.Service(_SRC[key][1], exact_scan)


def test_grouped_response_fields_match_f1():
    st, body = svc().handle('/api/fulltext', {'q': '學而'})
    assert st == 200
    assert F1_TOP <= set(body)
    assert body['normalized'] == '学而'
    g = body['groups'][0]
    assert F1_GROUP <= set(g)
    assert F1_HIT <= set(g['hits'][0])


def test_matches_are_chapter_codepoint_offsets():
    st, body = svc().handle('/api/fulltext', {'q': '學而時習之'})
    g = body['groups'][0]
    h = g['hits'][0]
    text = FakeSource(SAMPLE).text[('B1', '001')]
    a, b = h['matches'][0]
    assert text[a:b] == '學而時習之'
    assert h['label'] == '學而第一'


def test_snippet_marks_hit_and_escapes():
    books = {'X': {'title': 't', 'chapters': [('001', None, '甲<乙>學而時習之丙')]}}
    st, body = svc(books).handle('/api/fulltext', {'q': '學而時習之'})
    s = body['groups'][0]['hits'][0]['snippet']
    assert '<mark>學而時習之</mark>' in s
    assert '&lt;乙&gt;' in s


def test_book_grouping_counts_and_order():
    st, body = svc().handle('/api/fulltext', {'q': '學而'})
    assert body['total_books'] == 1          # B2 无「學而」
    assert body['groups'][0]['entry'] == 'B1'
    assert body['groups'][0]['hit_count'] == 3   # 章标题「學而第一」一段 + 正文两段
    assert body['has_more'] is False
    assert body['total_books_capped'] is False


def test_per_book_limits_hits_but_not_count():
    st, body = svc().handle('/api/fulltext', {'q': '學而', 'per_book': '1'})
    g = body['groups'][0]
    assert g['hit_count'] == 3 and len(g['hits']) == 1


def test_paging_by_book():
    st, body = svc().handle('/api/fulltext', {'q': '而', 'limit': '1', 'offset': '0'})
    assert body['total_books'] == 2
    assert len(body['groups']) == 1 and body['has_more'] is True
    st, body2 = svc().handle('/api/fulltext', {'q': '而', 'limit': '1', 'offset': '1'})
    assert len(body2['groups']) == 1 and body2['has_more'] is False
    assert body2['groups'][0]['entry'] != body['groups'][0]['entry']


def test_flat_group_none_returns_hits_with_entry_and_title():
    st, body = svc().handle('/api/fulltext', {'q': '而', 'group': 'none', 'limit': '2'})
    assert 'groups' not in body
    assert len(body['hits']) == 2
    assert {'entry', 'title'} <= set(body['hits'][0])
    assert body['has_more'] is True


def test_entry_filter_restricts_books():
    st, body = svc().handle('/api/fulltext', {'q': '學而', 'entry': 'B2'})
    assert body['total_books'] == 0 and body['groups'] == []


def test_exact_mode_uses_original_chars():
    # 原字「學」命中；简体「学」在 exact 下不命中（norm 才归一）
    st, body = svc().handle('/api/fulltext', {'q': '學而', 'mode': 'exact'})
    assert body['total_books'] == 1
    st, body = svc().handle('/api/fulltext', {'q': '学而', 'mode': 'exact'})
    assert body['total_books'] == 0


def test_fuzzy_matches_simplified_query_against_traditional_text():
    st, body = svc().handle('/api/fulltext', {'q': '学而'})
    assert body['total_books'] == 1


def test_fuzzy_counts_are_exact_not_capped():
    st, body = svc().handle('/api/fulltext', {'q': '而'})
    assert body['total_books_capped'] is False and body['capped'] is False
    assert body['total_hits'] == sum(g['hit_count'] for g in body['groups'])


def test_exact_scan_cap_sets_capped_flags():
    st, body = svc(exact_scan=1).handle('/api/fulltext', {'q': '而', 'mode': 'exact'})
    assert body['total_books_capped'] is True and body['capped'] is True


def test_exact_mode_filters_variant_chars_on_stored_text():
    # 「為」与「为」归一相同：fuzzy 两种写法都中；exact 只认原字
    st, body = svc().handle('/api/fulltext', {'q': '为政'})
    assert body['total_books'] == 1
    st, body = svc().handle('/api/fulltext', {'q': '為政', 'mode': 'exact'})
    assert body['total_books'] == 1 and body['groups'][0]['hits'][0]['snippet'].count('<mark>為政</mark>') == 1
    st, body = svc().handle('/api/fulltext', {'q': '为政', 'mode': 'exact'})
    assert body['total_books'] == 0


def test_exact_flat_mode_returns_entry_and_title():
    st, body = svc().handle('/api/fulltext', {'q': '學而', 'mode': 'exact', 'group': 'none'})
    assert body['total_hits'] == 3 and {'entry', 'title'} <= set(body['hits'][0])


def test_hits_within_book_follow_text_order():
    st, body = svc().handle('/api/fulltext', {'q': '學', 'per_book': '20'})
    hits = body['groups'][0]['hits']
    assert [(h['chapter'], h['passage'][0]) for h in hits] == sorted((h['chapter'], h['passage'][0]) for h in hits)


def test_long_query_truncated_flag():
    st, body = svc().handle('/api/fulltext', {'q': '學' * 61})
    assert body['truncated'] is True and len(body['q']) == 60


@pytest.mark.parametrize('q', ['', '   ', '，。、'])
def test_unsearchable_query_is_bad_query(q):
    st, body = svc().handle('/api/fulltext', {'q': q})
    assert st == 400 and body['error'] == 'bad_query'


@pytest.mark.parametrize('params', [
    {'q': 'x', 'mode': 'regex'},
    {'q': 'x', 'group': 'page'},
    {'q': 'x', 'limit': 'ten'},
    {'q': 'x', 'limit': '51'},
    {'q': 'x', 'per_book': '0'},
    {'q': 'x', 'offset': '-1'},
    {'q': 'x', 'entry': '../etc'},
])
def test_invalid_params_are_bad_query(params):
    st, body = svc().handle('/api/fulltext', params)
    assert st == 400 and body['error'] == 'bad_query'


def test_unknown_path_is_404():
    st, body = svc().handle('/api/search', {'q': '學'})
    assert st == 404


def test_http_round_trip():
    server = ThreadingHTTPServer(('127.0.0.1', 0), app.make_handler(svc()))
    t = threading.Thread(target=server.serve_forever, daemon=True)
    t.start()
    try:
        port = server.server_address[1]
        url = f'http://127.0.0.1:{port}/api/fulltext?' + urllib.parse.urlencode({'q': '學而'})
        with urllib.request.urlopen(url) as r:
            assert r.status == 200
            assert r.headers['Content-Type'].startswith('application/json')
            assert json.loads(r.read())['total_books'] == 1
        bad = f'http://127.0.0.1:{port}/api/fulltext?q='
        with pytest.raises(urllib.error.HTTPError) as ei:
            urllib.request.urlopen(bad)
        assert ei.value.code == 400
    finally:
        server.shutdown()


def test_per_book_cap_keeps_full_hit_count_and_ranked_order():
    st, body = svc().handle('/api/fulltext', {'q': '而', 'per_book': '1'})
    for g in body['groups']:
        assert len(g['hits']) == 1 and g['hit_count'] >= 1


def test_offset_past_end_is_empty_page():
    st, body = svc().handle('/api/fulltext', {'q': '學而', 'offset': '100'})
    assert st == 200 and body['groups'] == [] and body['has_more'] is False
    assert body['total_books'] == 1


def test_flat_hits_do_not_expose_ranking_internals():
    st, body = svc().handle('/api/fulltext', {'q': '而', 'group': 'none'})
    assert {'score', 'chapter_len', 'start'}.isdisjoint(body['hits'][0])


def test_group_hits_do_not_expose_ranking_internals():
    st, body = svc().handle('/api/fulltext', {'q': '而'})
    assert {'score', 'chapter_len', 'start', 'title', 'entry'}.isdisjoint(body['groups'][0]['hits'][0])


def test_boost_changes_book_order_through_service():
    s = app.Service(FakeSource(SAMPLE), boost={'B2': 10.0})
    st, body = s.handle('/api/fulltext', {'q': '而'})
    assert body['groups'][0]['entry'] == 'B2'
