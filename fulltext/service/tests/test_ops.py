"""分块-F4 步 3：并发闸、超时、索引不可用、/healthz、/admin/reload、章 LRU 按字节。"""
import json
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import ThreadingHTTPServer

import app
from cache import ByteLRU
from fakes import SAMPLE, FakeSource
from gate import Gate


class SlowSource(FakeSource):
    """candidates 睡 delay 秒，并记录同时在跑的最大数。"""

    def __init__(self, books, delay):
        super().__init__(books)
        self.delay = delay
        self.lock = threading.Lock()
        self.running = 0
        self.max_seen = 0

    def candidates(self, needle, field, entry, k):
        with self.lock:
            self.running += 1
            self.max_seen = max(self.max_seen, self.running)
        try:
            time.sleep(self.delay)
            return super().candidates(needle, field, entry, k)
        finally:
            with self.lock:
                self.running -= 1


class DeadSource(FakeSource):
    def candidates(self, needle, field, entry, k):
        raise app.IndexUnavailable('no index')


class ReloadableSource(FakeSource):
    """模拟章缓存挂在 source 上、reload 清空缓存并换 stamp。"""

    def __init__(self, books):
        super().__init__(books)
        self.cache = ByteLRU(1 << 20)
        self.stamp = 'v1'
        self.reloads = 0

    def chapter_text(self, entry, chapter):
        return self.cache.get_or_load((entry, chapter), lambda k: super(ReloadableSource, self).chapter_text(*k))

    def reload(self):
        self.reloads += 1
        self.cache.clear()
        self.stamp = f'v{self.reloads + 1}'
        return self.stamp


# ---- 并发闸 ----

def test_concurrency_never_exceeds_four_and_overflow_is_busy():
    src = SlowSource(SAMPLE, delay=0.2)
    svc = app.Service(src, 400, max_concurrent=4, queue_max=8, timeout_s=5.0)
    results = []
    lock = threading.Lock()

    def call():
        st, _ = svc.handle('/api/fulltext', {'q': '學'})
        with lock:
            results.append(st)

    threads = [threading.Thread(target=call) for _ in range(20)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert src.max_seen <= 4
    assert results.count(200) + results.count(503) == 20
    # 4 运行 + 8 排队 = 12 能进；其余 8 必须 503 busy
    assert results.count(503) >= 8
    assert results.count(200) >= 4


def test_queue_full_returns_busy_immediately():
    g = Gate(max_running=1, queue_max=0)
    assert g.acquire(0.1) is True
    assert g.acquire(0.1) is False          # 队满，不等
    g.release()
    assert g.acquire(0.1) is True


def test_queued_request_gives_up_after_timeout():
    g = Gate(max_running=1, queue_max=1)
    assert g.acquire(0.1) is True
    t0 = time.monotonic()
    assert g.acquire(0.2) is False          # 排队但等超时
    assert time.monotonic() - t0 < 1.0
    g.release()


def test_release_wakes_a_queued_waiter():
    g = Gate(max_running=1, queue_max=1)
    assert g.acquire(0.1)
    got = []
    t = threading.Thread(target=lambda: got.append(g.acquire(2.0)))
    t.start()
    time.sleep(0.05)
    g.release()
    t.join()
    assert got == [True]


# ---- 超时 ----

def test_slow_query_returns_504():
    svc = app.Service(SlowSource(SAMPLE, delay=0.5), 400, timeout_s=0.1)
    st, body = svc.handle('/api/fulltext', {'q': '學'})
    assert st == 504 and body['error'] == 'timeout'


def test_slot_is_held_until_worker_really_finishes():
    src = SlowSource(SAMPLE, delay=0.4)
    svc = app.Service(src, 400, max_concurrent=1, queue_max=0, timeout_s=0.1)
    st, _ = svc.handle('/api/fulltext', {'q': '學'})
    assert st == 504
    # 超时的查询仍在跑，闸位未释放 → 新请求直接 busy
    st2, body2 = svc.handle('/api/fulltext', {'q': '學'})
    assert st2 == 503 and body2['error'] == 'busy'
    time.sleep(0.5)
    src.delay = 0
    st3, _ = svc.handle('/api/fulltext', {'q': '學'})
    assert st3 == 200


# ---- 索引不可用 ----

def test_index_unavailable_returns_503():
    st, body = app.Service(DeadSource(SAMPLE), 400).handle('/api/fulltext', {'q': '學'})
    assert st == 503 and body['error'] == 'index_unavailable'


def test_bad_query_still_400_before_index_is_touched():
    st, body = app.Service(DeadSource(SAMPLE), 400).handle('/api/fulltext', {'q': ''})
    assert st == 400 and body['error'] == 'bad_query'


# ---- /healthz ----

def test_healthz_ok_when_probe_hits():
    st, body = app.Service(FakeSource(SAMPLE), 400).health()
    assert st == 200 and body['status'] == 'ok'


def test_healthz_503_when_index_cannot_open():
    st, body = app.Service(DeadSource(SAMPLE), 400).health()
    assert st == 503 and body['status'] == 'unavailable'


def test_healthz_503_when_probe_has_no_hits():
    st, _ = app.Service(FakeSource({}), 400).health()
    assert st == 503


# ---- /admin/reload 与章 LRU ----

def test_reload_clears_chapter_cache_and_returns_new_stamp():
    src = ReloadableSource(SAMPLE)
    svc = app.Service(src, 400)
    svc.handle('/api/fulltext', {'q': '學'})          # 填充缓存
    assert len(src.cache) > 0
    st, body = svc.reload()
    assert st == 200 and body['stamp'] == 'v2'
    assert len(src.cache) == 0
    assert src.reloads == 1


def test_reload_without_source_support_is_noop_200():
    st, body = app.Service(FakeSource(SAMPLE), 400).reload()
    assert st == 200 and body['stamp'] is None


def test_reload_index_unavailable_returns_503():
    class BrokenReload(FakeSource):
        def reload(self):
            raise app.IndexUnavailable('manifest missing')

    st, body = app.Service(BrokenReload(SAMPLE), 400).reload()
    assert st == 503 and body['error'] == 'index_unavailable'


def test_byte_lru_bounds_by_utf8_bytes_and_evicts_oldest():
    c = ByteLRU(max_bytes=9)                 # 3 个汉字 = 9 字节
    c.put('a', '學學學')
    assert c.size == 9
    c.put('b', '學')                          # 挤掉最久未用的 a
    assert c.get('a') is None and c.get('b') == '學'
    assert c.size == 3


def test_byte_lru_get_refreshes_recency():
    c = ByteLRU(max_bytes=12)                # 两个「學學」刚好放下
    c.put('a', '學學')
    c.put('b', '學學')
    c.get('a')                               # a 变新
    c.put('c', '學學')                        # 应挤掉 b
    assert c.get('b') is None and c.get('a') == '學學'


def test_byte_lru_skips_oversize_value_and_drops_old_copy():
    c = ByteLRU(max_bytes=3)
    c.put('a', '學')
    c.put('a', '學學')                        # 超限：不入缓存，旧值也要去掉
    assert c.get('a') is None and c.size == 0


def test_byte_lru_get_or_load_loads_once():
    c = ByteLRU(max_bytes=100)
    calls = []
    loader = lambda k: calls.append(k) or 'text'
    assert c.get_or_load('k', loader) == 'text'
    assert c.get_or_load('k', loader) == 'text'
    assert calls == ['k']


# ---- HTTP 层 ----

def _serve(svc):
    server = ThreadingHTTPServer(('127.0.0.1', 0), app.make_handler(svc))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, f'http://127.0.0.1:{server.server_address[1]}'


def _get(url):
    try:
        with urllib.request.urlopen(url, timeout=5) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read())


def _post(url):
    req = urllib.request.Request(url, data=b'', method='POST')
    try:
        with urllib.request.urlopen(req, timeout=5) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read())


def test_http_healthz_and_reload_round_trip():
    src = ReloadableSource(SAMPLE)
    server, base = _serve(app.Service(src, 400))
    try:
        assert _get(base + '/healthz')[0] == 200
        st, body = _post(base + '/admin/reload')
        assert st == 200 and body['stamp'] == 'v2'
        assert _get(base + '/admin/reload')[0] == 404      # 只接受 POST
    finally:
        server.shutdown()


def test_http_busy_and_timeout_status_codes():
    svc = app.Service(SlowSource(SAMPLE, delay=0.3), 400, max_concurrent=1, queue_max=0, timeout_s=0.1)
    server, base = _serve(svc)
    try:
        q = '/api/fulltext?' + urllib.parse.urlencode({'q': '學'})
        assert _get(base + q)[0] == 504
        st, body = _get(base + q)
        assert st == 503 and body['error'] == 'busy'
    finally:
        server.shutdown()
