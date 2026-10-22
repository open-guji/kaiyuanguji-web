"""检索接口 /api/fulltext（契约 F1，见 fulltext/docs/design.md）：参数校验 → 检索 → 组装响应。

v2 查询路径：
- fuzzy：命中段＝norm 层 phrase 命中（计数是准的）。group=book 时先按书聚合（entry 快字段），
  排好书序后只为当前页的书各取前 per_book 段（存储里带原文），只在这些段上定位、出摘要。
- exact：先按 norm 召回，再在存储原文上按原字逐段筛；扫描上限 exact_scan 段，超出时 capped=true。
不读 book-text、不读章 md。

Source 接口（见 source_tantivy.TantivySource 与 tests/fakes.FakeSource）：
book_title(entry)、count(needle, entry)、book_counts(needle, entry) -> (buckets, capped)、
passages(needle, entry, limit, offset, in_order) -> (段列表, 总数)；可选 reload() -> stamp。
索引打不开时抛 IndexUnavailable。
"""
import concurrent.futures
import hmac
import html
import json
import re
import time
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

from common import locate, locate_re, near_regex, norm_text, orig_text, query_stream
from gate import Gate
from ranking import rank_books

MAX_Q = 60                 # 超长截断并回 truncated:true
TOTAL_HITS_CAP = 10000     # total_hits 封顶
EXACT_SCAN = 3000          # exact／near 模式最多扫的候选段数（超出 capped=true）
NEAR_MIN = 4               # near（差一字）只对 ≥4 字的查询放宽；更短的按 fuzzy 查
NEAR_BATCH = 2048          # near 每批取的候选段数（先核验再计数，不再先截候选）
NEAR_BUDGET_S = 2.5        # near 核验的时间预算；Service 按自己的超时改小／放大
SNIPPET_PAD = 40           # 命中前后各取的字数
ENTRY_RE = re.compile(r'[0-9A-Za-z]{1,32}')
PROBE = '学'               # /healthz 样本查询（归一后的字）
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
    if mode not in ('fuzzy', 'exact', 'near'):
        raise BadQuery('mode 取值只能是 fuzzy、exact 或 near')
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


def _hit(d, needle, field, title=None):
    """段 → 响应里的一条命中；原文里定位不到（exact 模式下原字不符）返回 None。
    field='near' 时 needle 是 near_regex 编好的正则。"""
    raw = d['text']
    spans = locate_re(raw, needle) if field == 'near' else locate(raw, needle, field)
    if not spans:
        return None
    h = {
        'chapter': d['chapter'],
        'label': d.get('label'),
        'passage': [d['start'], d['end']],
        'matches': [[d['start'] + x, d['start'] + y] for x, y in spans],
        'snippet': snippet(raw, spans),
    }
    if title is not None:
        h = {'entry': d['entry'], 'title': title, **h}
    return h


def run_query(p, source, exact_scan=EXACT_SCAN, boost=None, near_budget_s=NEAR_BUDGET_S):
    """exact_scan：exact 模式最多扫的 norm 候选段数；near 模式最多计的有效命中段数。
    boost：{entry: 倍数}，缺省空。near_budget_s：near 核验的时间预算（秒）。"""
    t0 = time.perf_counter()
    qo, qn = query_stream(p.q)
    if not qn:
        raise BadQuery('q 全是不可检索字符（标点、空白）')
    exact = p.mode == 'exact'
    near = p.mode == 'near' and len(qn) >= NEAR_MIN
    needle, field = (qo, 'orig') if exact else (qn, 'norm')
    body = {'q': p.q, 'mode': p.mode, 'normalized': needle, 'truncated': p.truncated}

    if near:
        return _run_near(p, source, qn, body, t0, exact_scan, boost, near_budget_s)
    if not exact:
        if p.group == 'book':
            buckets, books_capped = source.book_counts(qn, p.entry)
            t1 = time.perf_counter()
            ranked = rank_books(buckets, boost)
            total = sum(b['count'] for b in buckets)
            groups = []
            for b in ranked[p.offset:p.offset + p.limit]:
                segs, _ = source.passages(qn, b['entry'], p.per_book, 0, True)
                hits = [h for h in (_hit(d, qn, 'norm') for d in segs) if h]
                groups.append({'entry': b['entry'], 'title': source.book_title(b['entry']),
                               'hit_count': b['count'], 'hits': hits})
            body.update(_totals(total, False), total_books=len(ranked), total_books_capped=books_capped,
                        has_more=p.offset + p.limit < len(ranked), groups=groups)
        else:
            segs, total = source.passages(qn, p.entry, p.limit, p.offset, False)
            t1 = time.perf_counter()
            hits = [h for h in (_hit(d, qn, 'norm', source.book_title(d['entry'])) for d in segs) if h]
            body.update(_totals(total, False), has_more=p.offset + p.limit < total, hits=hits)
    else:
        segs, n_cand = source.passages(qn, p.entry, exact_scan, 0, True)
        t1 = time.perf_counter()
        scan_capped = n_cand > exact_scan
        by_book, order = {}, []
        for d in segs:
            if qo not in orig_text(d['text']):   # 与 locate(..., 'orig') 同判定，快约 6 倍
                continue
            e = d['entry']
            if e not in by_book:
                by_book[e] = {'entry': e, 'count': 0, 'long': False, 'segs': []}
                order.append(e)
            g = by_book[e]
            g['count'] += 1
            g['long'] = g['long'] or d['long']
            g['segs'].append(d)
        total = sum(g['count'] for g in by_book.values())
        if p.group == 'book':
            ranked = rank_books([by_book[e] for e in order], boost)
            groups = [{'entry': g['entry'], 'title': source.book_title(g['entry']), 'hit_count': g['count'],
                       'hits': [_hit(d, qo, 'orig') for d in g['segs'][:p.per_book]]}
                      for g in ranked[p.offset:p.offset + p.limit]]
            body.update(_totals(total, scan_capped), total_books=len(ranked), total_books_capped=scan_capped,
                        has_more=p.offset + p.limit < len(ranked), groups=groups)
        else:
            flat = [d for e in order for d in by_book[e]['segs']]
            hits = [_hit(d, qo, 'orig', source.book_title(d['entry'])) for d in flat[p.offset:p.offset + p.limit]]
            body.update(_totals(total, scan_capped), has_more=p.offset + p.limit < total, hits=hits)
    t2 = time.perf_counter()
    body['took_ms'] = {
        'search': round((t1 - t0) * 1000, 1),
        'locate': round((t2 - t1) * 1000, 1),
        'total': round((t2 - t0) * 1000, 1),
    }
    return body


def _run_near(p, source, qn, body, t0, scan, boost, budget_s=NEAR_BUDGET_S):
    """near（差一字）：按差一字召回候选，按书内顺序每批取 NEAR_BATCH 段，在归一原文上用正则核，再分组。
    先核验、再对有效命中套 scan 上限（ai-team PR #37 的修正：旧版先截 3000 个候选，后面的真命中会丢，
    如「學而習之」全库 2508 段只返回 466 段）。有效命中到 scan、或超出时间预算时停下，capped=true。
    只留展示要用的段（分组时每书 per_book 段，平铺时前 offset+limit 段），不累积全部候选原文。
    完全命中原串的书排在前面。"""
    rx = near_regex(qn)
    keep_flat = p.offset + p.limit
    by_book, order, flat = {}, [], []
    total, offset, capped = 0, 0, False
    deadline = t0 + budget_s
    while True:
        segs, n_cand = source.passages(qn, p.entry, NEAR_BATCH, offset, True, near=True)
        offset += len(segs)
        for d in segs:
            t = norm_text(d['text'])
            if not rx.search(t):
                continue
            total += 1
            e = d['entry']
            if e not in by_book:
                by_book[e] = {'entry': e, 'count': 0, 'exact': 0, 'long': False, 'segs': []}
                order.append(e)
            g = by_book[e]
            g['count'] += 1
            g['exact'] += qn in t
            g['long'] = g['long'] or d['long']
            if p.group == 'book':
                if len(g['segs']) < p.per_book:
                    g['segs'].append(d)
            elif len(flat) < keep_flat:
                flat.append(d)
            if total >= scan:
                break
        if total >= scan:
            capped = offset < n_cand
            break
        if not segs or offset >= n_cand:
            break
        if time.perf_counter() > deadline:
            capped = True
            break
    t1 = time.perf_counter()
    if p.group == 'book':
        ranked = rank_books([by_book[e] for e in order], boost)
        ranked.sort(key=lambda g: g['exact'] == 0)        # 稳定排序：有原串的书在前，各自保持书分顺序
        groups = [{'entry': g['entry'], 'title': source.book_title(g['entry']), 'hit_count': g['count'],
                   'exact_count': g['exact'],
                   'hits': [h for h in (_hit(d, rx, 'near') for d in g['segs']) if h]}
                  for g in ranked[p.offset:p.offset + p.limit]]
        body.update(_totals(total, capped), total_books=len(ranked), total_books_capped=capped,
                    has_more=p.offset + p.limit < len(ranked), groups=groups)
    else:
        hits = [h for h in (_hit(d, rx, 'near', source.book_title(d['entry']))
                            for d in flat[p.offset:p.offset + p.limit]) if h]
        body.update(_totals(total, capped), has_more=p.offset + p.limit < total, hits=hits)
    t2 = time.perf_counter()
    body['took_ms'] = {'search': round((t1 - t0) * 1000, 1), 'locate': round((t2 - t1) * 1000, 1),
                       'total': round((t2 - t0) * 1000, 1)}
    return body


def _totals(total, capped):
    return {'total_hits': min(total, TOTAL_HITS_CAP), 'capped': capped or total > TOTAL_HITS_CAP}


class Service:
    """把 (方法, 路径, 查询参数) 变成 (状态码, JSON 体)。HTTP 层与测试共用。

    并发：每个 /api/fulltext 请求先过 Gate（运行 ≤ max_concurrent，排队 ≤ queue_max，
    否则 503 busy）；查询在线程池里跑，超过 timeout_s 不再等，回 504。
    Tantivy 查询无法中断，所以闸位在查询线程真正结束时才释放（而不是在超时时释放），
    保证同时在跑的查询数始终 ≤ max_concurrent。
    """

    def __init__(self, source, exact_scan=EXACT_SCAN, boost=None, max_concurrent=4, queue_max=8, timeout_s=3.0):
        self.source = source
        self.exact_scan = exact_scan
        self.boost = boost or {}
        self.timeout_s = timeout_s
        self.gate = Gate(max_concurrent, queue_max)
        self._pool = concurrent.futures.ThreadPoolExecutor(max_workers=max_concurrent)
        self.ready = True          # 启动预热期间为 False（见 run.py），就绪前不接检索请求

    def warm(self, terms):
        """启动预热：对每个词跑一遍 run_query，把相关索引页读进 OS 缓存。
        不走闸门与超时（启动时没有并发）；单词失败只跳过，不挡就绪。返回 (成功词数, 失败词数)。"""
        ok = failed = 0
        for t in terms:
            try:
                run_query(parse_params({'q': t}), self.source, self.exact_scan, self.boost)
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
            # near 分批核验要在服务超时前收手（留 20% 给分组与片段），超出就 capped，不拿 504 丢掉已核的结果
            return run_query(p, self.source, self.exact_scan, self.boost, max(0.5, self.timeout_s * 0.8))
        finally:
            self.gate.release()

    def health(self):
        """预热未完成 → 503 warming；索引可开且样本查询有命中 → 200，否则 503。"""
        if not self.ready:
            return 503, {'status': 'warming'}
        try:
            ok = self.source.count(PROBE) > 0
        except IndexUnavailable:
            ok = False
        if ok:
            return 200, {'status': 'ok'}
        return 503, {'status': 'unavailable'}

    def reload(self):
        """重开索引目录（由 Source.reload 实现），返回新 manifest stamp。"""
        reopen = getattr(self.source, 'reload', None)
        if reopen is None:
            return 200, {'status': 'reloaded', 'stamp': None}
        try:
            stamp = reopen()
        except IndexUnavailable:
            return 503, {'error': 'index_unavailable', 'message': '索引不可用'}
        return 200, {'status': 'reloaded', 'stamp': stamp}


def make_handler(service, edge_token=''):
    """edge_token：非本机来源必须带请求头 X-FT-Token 等于它才能查 /api/fulltext（EdgeOne 边缘函数带）。
    没配令牌时非本机来源一律 404；/healthz、/admin/* 对非本机来源一律 404（GUJI-616 收口要求）。"""
    def remote_allowed(handler):
        if handler.client_address[0] in LOOPBACK:
            return True
        got = handler.headers.get('X-FT-Token', '')
        return bool(edge_token) and hmac.compare_digest(got.encode(), edge_token.encode())

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
            local = self.client_address[0] in LOOPBACK
            if not local and (u.path != '/api/fulltext' or not remote_allowed(self)):
                return self._send(404, {'error': 'not_found', 'message': u.path})
            if u.path == '/healthz':
                return self._send(*service.health())
            query = {k: v[0] for k, v in parse_qs(u.query, keep_blank_values=True).items()}
            self._send(*service.handle(u.path, query))

        def do_POST(self):
            u = urlparse(self.path)
            if u.path != '/admin/reload':
                return self._send(404, {'error': 'not_found', 'message': u.path})
            # 运维接口只对本机开放：非本机来源当作不存在
            if self.client_address[0] not in LOOPBACK:
                return self._send(404, {'error': 'not_found', 'message': u.path})
            self._send(*service.reload())

        def log_message(self, *args):
            pass

    return Handler


def serve(service, host, port, edge_token=''):
    ThreadingHTTPServer((host, port), make_handler(service, edge_token)).serve_forever()
