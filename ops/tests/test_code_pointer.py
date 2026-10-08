"""ops/code_pointer.py 与 ops/code-pointer.mjs、edge-functions/api/version.js、deploy.yml 内联段的口径一致性（overview#470 P1 方案 A）。"""
import json
import os
import subprocess
import sys
import tempfile
import unittest

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
sys.path.insert(0, os.path.join(ROOT, 'ops'))
import code_pointer  # noqa: E402

CASES = json.load(open(os.path.join(ROOT, 'ops', 'tests', 'fixtures', 'code-pointer-cases.json'), encoding='utf-8'))


class CodePointerPython(unittest.TestCase):
    def test_case_table(self):
        for c in CASES:
            r = code_pointer.resolve(c['latest'], c['web'])
            self.assertEqual((r['commit'], r['source'], r['marked'], r['mismatch']),
                             (c['commit'], c['source'], c['marked'], c['mismatch']), c['name'])

    def test_mismatch_is_never_silent(self):
        for c in CASES:
            r = code_pointer.resolve(c['latest'], c['web'])
            if r['mismatch']:
                self.assertTrue(r['notes'], c['name'])
                self.assertTrue(any(c['latest']['webCommitId'][:12] in n and c['web']['webCommitId'][:12] in n for n in r['notes']), c['name'])
            if c['marked'] and c['source'].startswith('latest.json（'):
                self.assertTrue(r['notes'], c['name'])   # 退回要说出来

    def test_cli_prints_chosen_commit(self):
        for c in CASES:
            with tempfile.TemporaryDirectory() as d:
                lp, wp = os.path.join(d, 'l.json'), os.path.join(d, 'w.json')
                json.dump(c['latest'], open(lp, 'w'))
                args = [sys.executable, os.path.join(ROOT, 'ops', 'code_pointer.py'), lp]
                if c['web'] is None:
                    args.append('-')
                else:
                    json.dump(c['web'], open(wp, 'w')); args.append(wp)
                r = subprocess.run(args, capture_output=True, text=True)
                self.assertEqual(r.returncode, 0, r.stderr)
                self.assertEqual(r.stdout.strip(), c['commit'], c['name'])



try:
    import yaml
except ImportError:
    yaml = None


@unittest.skipIf(yaml is None, 'PyYAML 未安装')
class DeployInlineResolver(unittest.TestCase):
    """deploy.yml 的 resolve 里内联的 code_commit（promote=data／code+data 读线上代码是哪一版）与 ops/code_pointer.py 同口径。"""

    @classmethod
    def setUpClass(cls):
        import re
        wf = yaml.safe_load(open(os.path.join(ROOT, '.github', 'workflows', 'deploy.yml'), encoding='utf-8'))
        step = [x for x in wf['jobs']['resolve']['steps'] if x.get('id') == 'r'][0]
        m = re.search(r"code_commit\(\) \{\n\s*KYG_PFX=\"\$1\" python3 - <<'PY'\n(.*?)\nPY\n", step['run'], re.S)
        assert m, '找不到 code_commit 的内联 python'
        cls.script = m.group(1)

    def _serve(self, root):
        import functools
        import http.server
        import threading
        h = functools.partial(http.server.SimpleHTTPRequestHandler, directory=root)
        h.log_message = lambda *a, **k: None
        srv = http.server.ThreadingHTTPServer(('127.0.0.1', 0), h)
        threading.Thread(target=lambda: srv.serve_forever(poll_interval=0.01), daemon=True).start()
        return srv

    def test_case_table_both_prefixes(self):
        for c in CASES:
            for pfx in ('', 'staging/'):
                with tempfile.TemporaryDirectory() as d:
                    sub = os.path.join(d, pfx) if pfx else d
                    os.makedirs(sub, exist_ok=True)
                    if c['latest'] is not None and '_error' not in c['latest']:
                        json.dump(c['latest'], open(os.path.join(sub, 'latest.json'), 'w'))
                    if c['web'] is not None:
                        json.dump(c['web'], open(os.path.join(sub, 'web.json'), 'w'))
                    srv = self._serve(d)
                    try:
                        env = dict(os.environ, KYG_PFX=pfx, KYG_DATA_BASE=f'http://127.0.0.1:{srv.server_address[1]}')
                        r = subprocess.run([sys.executable, '-c', self.script], env=env, capture_output=True, text=True)
                    finally:
                        srv.shutdown(); srv.server_close()
                    self.assertEqual(r.returncode, 0, r.stderr)
                    self.assertEqual(r.stdout.strip(), c['commit'], (c['name'], pfx))


if __name__ == '__main__':
    unittest.main()
