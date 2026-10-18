"""F1 检索接口 /api/fulltext：参数校验 → 候选段 → 回映命中 → 组装响应。

步 1：骨架，候选来源经 Source 接口注入，本文件不依赖 Tantivy。
步 2：排序在 ranking.py；本文件调用 group_and_rank。
步 3：全局并发闸（gate.py）、超时（504）、索引不可用（503）、运维接口 /healthz 与 /admin/reload（仅本机）。

Source 接口：book_title(entry)、chapter_text(entry, chapter)、candidates(needle, field, entry, k)；
可选：reload() -> stamp（清章缓存、重开索引）。索引打不开时 candidates/reload 抛 IndexUnavailable。
"""
import concurrent.futures
import html
import json
import re
import time
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

from common import locate, query_stream
from gate import Gate
from ranking import group_and_rank

MAX_Q = 60                 # 超长截断并回 truncated:true
TOTAL_HITS_CAP = 10000     # total_hits 封顶
SNIPPET_PAD = 40           # 命中前后各取的字数
ENTRY_RE = re.compile(r'[0-9A-Za-z]{1,32}')
PROBE = ('学', 'norm')     # /healthz 样本查询（归一后的字与字段）
LOOPBACK = ('127.0.0.1', '::1')


class BadQuery(Exception):
    def __init__(self, message):
        super().__init__(message)
        self.message = message


class IndexUnavailable(Exception):
    """索引目录打不开（不存在、损坏、版本不符）。"""


@dataclass(frozen=True)
class Params:
    q: str
    truncated: bool
    mode: str
    group: str
    limit: int
    offset: int
    per_book: int
    entry: str | None


def _int(p, name, default, lo, hi):
    raw = p.get(name)
    if raw is None or raw == '':
        return default
    try:
        v = int(raw)
    except ValueError:
        raise BadQuery(f'{name} 必须是整数')
    if not lo <= v <= hi:
        raise BadQuery(f'{name} 超出范围 [{lo}, {hi}]')
    return v


def parse_params(p):
    """p：查询串解析后的 dict（取每个键的第一个值）。"""
    q = p.get('q', '')
    if not q.strip():
        raise BadQuery('q 不能为空')
    mode = p.get('mode', 'fuzzy')
    if mode not in ('fuzzy', 'exact'):
        raise BadQuery('mode 取值只能是 fuzzy 或 exact')
    group = p.get('group', 'book')
    if group not in ('book', 'none'):
        raise BadQuery('group 取值只能是 book 或 none')
    entry = p.get('entry') or None
    if entry is not None and not ENTRY_RE.fullmatch(entry):
        raise BadQuery('entry 格式非法')
    return Params(
        q=q[:MAX_Q],
        truncated=len(q) > MAX_Q,
        mode=mode,
        group=group,
        limit=_int(p, 'limit', 10, 1, 50),
        offset=_int(p, 'offset', 0, 0, 10**9),
        per_book=_int(p, 'per_book', 3, 1, 20),
        entry=entry,
    )


def snippet(raw, spans):
    """命中前后各 SNIPPET_PAD 字，命中处 <mark>，其余转义（F1：前端可直接 innerHTML）。"""
    L = max(0, spans[0][0] - SNIPPET_PAD)
    R = min(len(raw), spans[0][1] + SNIPPET_PAD)
    parts, cur = [], L
    for x, y in spans:
        if x < L or y > R:
            continue
        parts.append(html.escape(raw[cur:x]))
        parts.append('<mark>' + html.escape(raw[x:y]) + '</mark>')
        cur = y
    parts.append(html.escape(raw[cur:R]))
    return ''.join(parts).replace('\n', ' ')


def run_query(p, source, candidates, boost=None):
    """source：候选与正文来源（见 FakeSource）。candidates：候选段上限，None = 不截断。
    boost：{entry: 倍数}，排序用，缺省空。"""
    t0 = time.perf_counter()
    qo, qn = query_stream(p.q)
    field, needle = ('norm', qn) if p.mode == 'fuzzy' else ('orig', qo)
    if not needle:
        raise BadQuery('q 全是不可检索字符（标点、空白）')

    segs = source.candidates(needle, field, p.entry, candidates)
    t1 = time.perf_counter()

    hits = []
    for s in segs:
        text = source.chapter_text(s['entry'], s['chapter'])
        raw = text[s['start']:s['end']]
        spans = locate(raw, needle, field)
        if not spans:
            continue
        hits.append({
            'entry': s['entry'],
            'title': source.book_title(s['entry']),
            'chapter': s['chapter'],
            'label': s.get('label'),
            'passage': [s['start'], s['end']],
            'matches': [[s['start'] + a, s['start'] + b] for a, b in spans],
            'snippet': snippet(raw, spans),
            'score': s.get('score', 1.0),          # 候选分（BM25）；无则 1.0
            'chapter_len': len(text),              # 短章降权用
            'start': s['start'],
        })
    t2 = time.perf_counter()

    cands_truncated = candidates is not None and len(segs) >= candidates
    body = {
        'q': p.q,
        'mode': p.mode,
        'normalized': needle,
        'truncated': p.truncated,
        'total_hits': min(len(hits), TOTAL_HITS_CAP),
        'capped': len(hits) > TOTAL_HITS_CAP or cands_truncated,
    }
    if p.group == 'book':
        groups, total_books = group_by_book(hits, p.offset, p.limit, p.per_book, boost)
        body.update({
            'total_books': total_books,
            'total_books_capped': cands_truncated,
            'has_more': p.offset + p.limit < total_books,
            'groups': groups,
        })
    else:
        page = [{k: h[k] for k in FLAT} for h in hits[p.offset:p.offset + p.limit]]
        body.update({'has_more': p.offset + p.limit < len(hits), 'hits': page})
    body['took_ms'] = {
        'search': round((t1 - t0) * 1000, 1),
        'locate': round((t2 - t1) * 1000, 1),
        'total': round((t2 - t0) * 1000, 1),
    }
    return body


KEEP = ('chapter', 'label', 'passage', 'matches', 'snippet')
FLAT = ('entry', 'title') + KEEP


def group_by_book(hits, offset, limit, per_book, boost=None):
    """排序分组后按书分页；每书只回前 per_book 条，hit_count 为全部命中段数。"""
    ranked = group_and_rank(hits, boost)
    groups = []
    for g in ranked[offset:offset + limit]:
        first = g['hits'][0]
        groups.append({
            'entry': g['entry'],
            'title': first['title'],
            'hit_count': g['hit_count'],
            'hits': [{k: h[k] for k in KEEP} for h in g['hits'][:per_book]],
        })
    return groups, len(ranked)


class Service:
    """把 (方法, 路径, 查询参数) 变成 (状态码, JSON 体)。HTTP 层与测试共用。

    并发：每个 /api/fulltext 请求先过 Gate（运行 ≤ max_concurrent，排队 ≤ queue_max，
    否则 503 busy）；查询在线程池里跑，超过 timeout_s 不再等，回 504。
    Tantivy 查询无法中断，所以闸位在查询线程真正结束时才释放（而不是在超时时释放），
    保证同时在跑的查询数始终 ≤ max_concurrent。
    """

    def __init__(self, source, candidates, boost=None, max_concurrent=4, queue_max=8, timeout_s=3.0):
        self.source = source
        self.candidates = candidates
        self.boost = boost or {}
        self.timeout_s = timeout_s
        self.gate = Gate(max_concurrent, queue_max)
        self._pool = concurrent.futures.ThreadPoolExecutor(max_workers=max_concurrent)
        self.ready = True          # 启动预热期间为 False（见 run.py），就绪前不接检索请求

    def warm(self, terms):
        """启动预热：对每个词跑一遍 run_query，把候选章读进章 LRU、索引页读进 OS 缓存。
        不走闸门与超时（启动时没有并发）；单词失败只跳过，不挡就绪。返回 (成功词数, 失败词数)。"""
        ok = failed = 0
        for t in terms:
            try:
                run_query(parse_params({'q': t}), self.source, self.candidates, self.boost)
                ok += 1
            except (BadQuery, OSError, IndexUnavailable):
                failed += 1
        return ok, failed

    def handle(self, path, query):
        if path != '/api/fulltext':
            return 404, {'error': 'not_found', 'message': path}
        if not self.ready:
            return 503, {'error': 'warming', 'message': '索引预热中，请稍后重试'}
        try:
            p = parse_params(query)
        except BadQuery as e:
            return 400, {'error': 'bad_query', 'message': e.message}
        if not self.gate.acquire(self.timeout_s):
            return 503, {'error': 'busy', 'message': '检索繁忙，请稍后重试'}
        fut = self._pool.submit(self._run, p)
        try:
            return 200, fut.result(timeout=self.timeout_s)
        except concurrent.futures.TimeoutError:
            return 504, {'error': 'timeout', 'message': '检索超时'}
        except BadQuery as e:
            return 400, {'error': 'bad_query', 'message': e.message}
        except IndexUnavailable:
            return 503, {'error': 'index_unavailable', 'message': '索引不可用'}

    def _run(self, p):
        try:
            return run_query(p, self.source, self.candidates, self.boost)
        finally:
            self.gate.release()

    def health(self):
        """预热未完成 → 503 warming；索引可开且样本查询有命中 → 200，否则 503。"""
        if not self.ready:
            return 503, {'status': 'warming'}
        try:
            ok = bool(self.source.candidates(PROBE[0], PROBE[1], None, 1))
        except IndexUnavailable:
            ok = False
        if ok:
            return 200, {'status': 'ok'}
        return 503, {'status': 'unavailable'}

    def reload(self):
        """重开索引目录、清空章 LRU（由 Source.reload 实现），返回新 manifest stamp。"""
        reopen = getattr(self.source, 'reload', None)
        if reopen is None:
            return 200, {'status': 'reloaded', 'stamp': None}
        try:
            stamp = reopen()
        except IndexUnavailable:
            return 503, {'error': 'index_unavailable', 'message': '索引不可用'}
        return 200, {'status': 'reloaded', 'stamp': stamp}


def make_handler(service):
    class Handler(BaseHTTPRequestHandler):
        def _send(self, status, obj):
            body = json.dumps(obj, ensure_ascii=False).encode('utf-8')
            self.send_response(status)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            u = urlparse(self.path)
            if u.path == '/healthz':
                return self._send(*service.health())
            query = {k: v[0] for k, v in parse_qs(u.query, keep_blank_values=True).items()}
            self._send(*service.handle(u.path, query))

        def do_POST(self):
            u = urlparse(self.path)
            if u.path != '/admin/reload':
                return self._send(404, {'error': 'not_found', 'message': u.path})
            # 运维接口只对本机开放（服务即使误绑到公网地址，也拒绝非本机来源）
            if self.client_address[0] not in LOOPBACK:
                return self._send(403, {'error': 'forbidden', 'message': '仅限本机'})
            self._send(*service.reload())

        def log_message(self, *args):
            pass

    return Handler


def serve(service, host, port):
    ThreadingHTTPServer((host, port), make_handler(service)).serve_forever()
