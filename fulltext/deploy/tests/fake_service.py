#!/usr/bin/env python3
"""rotate/rollback 单测用的假检索服务：每次请求现读索引目录（模拟 reload 后见新索引）。

FT_PORT：监听端口；FT_INDEX_DIR：索引目录，缺省取 $FT_ROOT/current/index（跟着符号链接走）。
/healthz：index/OK 可读且能在 index/ 里建 .tantivy-meta.lock（模拟 tantivy）→ 200，否则 503；index/FLAKY 存在且端口不是自检端口 → 503（模拟“自检过、上线后不健康”）。
/api/fulltext：index/OK 存在 → total_hits=3，否则 0。
"""
import json
import os
from http.server import BaseHTTPRequestHandler, HTTPServer

PORT = int(os.environ['FT_PORT'])
SELF_PORT = int(os.environ.get('FT_SELFCHECK_PORT', '18765'))


def index_dir():
    return os.environ.get('FT_INDEX_DIR') or os.path.join(os.environ['FT_ROOT'], 'current', 'index')


def readable(p):
    try:
        with open(p, 'rb'):
            return True
    except OSError:
        return False


def can_lock(d):
    """模拟 tantivy：打开索引要在索引目录里建／写 .tantivy-meta.lock。"""
    try:
        with open(os.path.join(d, '.tantivy-meta.lock'), 'ab'):
            return True
    except FileNotFoundError:
        return False
    except PermissionError:
        return False


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send(self, code, obj):
        b = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header('Content-Length', str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def do_GET(self):
        d = index_dir()
        ok = readable(os.path.join(d, 'OK')) and can_lock(d)
        flaky = os.path.exists(os.path.join(d, 'FLAKY')) and PORT != SELF_PORT
        if self.path.startswith('/healthz'):
            return self._send(200 if ok and not flaky else 503, {'ok': ok and not flaky})
        return self._send(200, {'total_hits': 3 if ok else 0})


HTTPServer(('127.0.0.1', PORT), H).serve_forever()
