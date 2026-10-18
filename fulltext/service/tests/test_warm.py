import os
import threading

import app
from fakes import SAMPLE, FakeSource


def svc():
    return app.Service(FakeSource(SAMPLE))


def test_not_ready_gates_handle_and_health_with_503_warming():
    s = svc()
    s.ready = False
    st, body = s.handle('/api/fulltext', {'q': '學而'})
    assert st == 503 and body['error'] == 'warming'
    st, body = s.health()
    assert st == 503 and body['status'] == 'warming'


def test_ready_after_warm_serves_queries():
    s = svc()
    s.ready = False
    ok, failed = s.warm(['學而', '孟子'])
    assert (ok, failed) == (2, 0)
    s.ready = True
    st, body = s.handle('/api/fulltext', {'q': '學而'})
    assert st == 200 and body['total_hits'] >= 1
    assert s.health()[0] == 200


def test_warm_skips_unsearchable_terms_without_raising():
    s = svc()
    ok, failed = s.warm(['學而', '，。', '不存在的字串甲乙'])
    assert (ok, failed) == (2, 1)  # 标点词抛 BadQuery 计失败；无命中词不算失败


def test_prefetch_skips_doc_store_and_reports_bytes(tmp_path):
    from source_tantivy import TantivySource
    (tmp_path / 'a.idx').write_bytes(b'x' * 1000)
    (tmp_path / 'a.store').write_bytes(b'z' * 5000)     # 原文存储块不预读
    (tmp_path / 'sub').mkdir()
    (tmp_path / 'sub' / 'b.bin').write_bytes(b'y' * 10)
    src = TantivySource.__new__(TantivySource)
    src.index_dir = str(tmp_path)
    nbytes, secs = src.prefetch_index()
    assert nbytes == 1000 and secs >= 0
