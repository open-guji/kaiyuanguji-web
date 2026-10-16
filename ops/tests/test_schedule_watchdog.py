"""ops/schedule_watchdog.py：定时"该跑未跑"判断（GUJI-143）。不联网：GitHub API 用本地假服务顶替。"""
import datetime as dt
import http.server
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import threading
import unittest

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
SCRIPT = os.path.join(ROOT, 'ops', 'schedule_watchdog.py')
spec = importlib.util.spec_from_file_location('schedule_watchdog', SCRIPT)
sw = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sw)

U = dt.timezone.utc


def t(s):
    return dt.datetime.strptime(s, '%Y-%m-%dT%H:%M').replace(tzinfo=U)


class Judge(unittest.TestCase):
    def test_run_after_slot_is_ok_even_when_late(self):
        # 20:30 的 cron，常态 23:48 才跑：now 在 00:30，run 在 23:48，算 ok
        st, slot, _ = sw.judge(t('2026-10-14T00:30'), '30 20 * * *', 6, [t('2026-10-13T23:48')])
        self.assertEqual((st, slot), ('ok', t('2026-10-13T20:30')))

    def test_within_grace_is_pending_not_overdue(self):
        # 距 20:00 只晚 41 分钟——卡里最初的"漏跑"判断，现在应是 pending
        st, _, _ = sw.judge(t('2026-10-13T20:41'), '0 20 * * *', 6, [t('2026-10-11T23:33')])
        self.assertEqual(st, 'pending')

    def test_past_grace_without_run_is_overdue(self):
        st, slot, latest = sw.judge(t('2026-10-14T05:00'), '0 20 * * *', 6, [t('2026-10-11T23:33')])
        self.assertEqual((st, slot, latest), ('overdue', t('2026-10-13T20:00'), t('2026-10-11T23:33')))

    def test_never_ran_is_overdue_after_grace(self):
        st, _, latest = sw.judge(t('2026-10-14T05:00'), '10 21 * * *', 6, [])
        self.assertEqual((st, latest), ('overdue', None))

    def test_yesterdays_run_does_not_cover_todays_slot(self):
        st, _, _ = sw.judge(t('2026-10-14T05:00'), '30 20 * * *', 6, [t('2026-10-13T02:10')])
        self.assertEqual(st, 'overdue')

    def test_slot_not_yet_reached_uses_yesterday(self):
        _, slot, _ = sw.judge(t('2026-10-14T10:00'), '30 20 * * *', 6, [])
        self.assertEqual(slot, t('2026-10-13T20:30'))

    def test_overdue_with_run_number_gap_is_suspect_until_double_grace(self):
        # 列表漏列过 run（先后返回 0 条和 7 条的那次）：有断档时先不判漏跑
        st, _, _ = sw.judge(t('2026-10-14T05:00'), '0 20 * * *', 6, [t('2026-10-11T23:33')], gaps=[22, 23])
        self.assertEqual(st, 'suspect')
        # 断档一直不补：到 2 倍宽限（20:00+12h＝08:00）就按漏跑处理
        st, _, _ = sw.judge(t('2026-10-14T08:00'), '0 20 * * *', 6, [t('2026-10-11T23:33')], gaps=[22, 23])
        self.assertEqual(st, 'overdue')

    def test_gaps_do_not_change_ok_or_pending(self):
        self.assertEqual(sw.judge(t('2026-10-14T00:30'), '30 20 * * *', 6, [t('2026-10-13T23:48')], gaps=[1])[0], 'ok')
        self.assertEqual(sw.judge(t('2026-10-13T20:41'), '0 20 * * *', 6, [], gaps=[1])[0], 'pending')

    def test_rejects_unsupported_cron(self):
        for bad in ('7 * * * *', '*/5 * * * *', '30 20 * * 1', 'x y * * *', '70 20 * * *', '0 25 * * *', ''):
            with self.assertRaises(ValueError, msg=bad):
                sw.parse_cron(bad)


class Fetch(unittest.TestCase):
    def test_rejects_odd_repo_or_workflow(self):
        for repo, wf in (('-x/y', 'a.yml'), ('o/r/../x', 'a.yml'), ('o/r', '../a.yml'), ('o/r', 'a.yml?x=1'),
                         ('o r/x', 'a.yml'), ('o/r', 'a.sh'), ('o', 'a.yml'), ('o/r', '')):
            with self.assertRaises(ValueError, msg=(repo, wf)):
                sw.fetch_schedule_runs(repo, wf, 'tok', api='http://127.0.0.1:1')


class Cli(unittest.TestCase):
    """起一个本地假的 GitHub API，GITHUB_API_URL 指过去，不联网。"""

    def run_cli(self, handler_status, handler_body, *extra, all_body=None):
        seen = {'paths': []}
        if all_body is None:
            all_body = {'workflow_runs': []}

        class H(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                seen['paths'].append(self.path)
                seen['auth'] = self.headers.get('Authorization')
                data = json.dumps(handler_body if 'event=schedule' in self.path else all_body).encode()
                self.send_response(handler_status)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def log_message(self, *a):
                pass

        srv = http.server.HTTPServer(('127.0.0.1', 0), H)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        try:
            d = tempfile.mkdtemp()
            out = os.path.join(d, 'out.json')
            env = dict(os.environ, GITHUB_API_URL=f'http://127.0.0.1:{srv.server_port}', GH_TOKEN='secret-tok')
            p = subprocess.run([sys.executable, '-I', SCRIPT, '--now', '2026-10-14T05:00:00Z', '--out', out, *extra],
                               capture_output=True, text=True, env=env)
        finally:
            srv.shutdown()
            srv.server_close()
        data = None
        if os.path.exists(out):
            with open(out) as f:
                data = json.load(f)
        return p, data, seen

    def test_overdue_listed_exit_zero_and_request_shape(self):
        body = {'workflow_runs': [{'created_at': '2026-10-11T23:33:21Z'}]}
        p, data, seen = self.run_cli(200, body, '--watch', 'o/r:a.yml:0 20 * * *:6')
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertEqual([(r['key'], r['status']) for r in data], [('o/r/a.yml', 'overdue')])
        self.assertEqual(seen['paths'], ['/repos/o/r/actions/workflows/a.yml/runs?event=schedule&per_page=5',
                                         '/repos/o/r/actions/workflows/a.yml/runs?per_page=100'])
        self.assertEqual(seen['auth'], 'Bearer secret-tok')
        self.assertNotIn('secret-tok', p.stdout + p.stderr)

    def test_ok_when_run_after_slot(self):
        body = {'workflow_runs': [{'created_at': '2026-10-14T01:10:00Z'}]}
        p, data, _ = self.run_cli(200, body, '--watch', 'o/r:a.yml:0 20 * * *:6')
        self.assertEqual(data[0]['status'], 'ok')

    def test_gap_in_unfiltered_list_makes_overdue_suspect(self):
        sched = {'workflow_runs': [{'created_at': '2026-10-11T23:33:21Z', 'run_number': 21}]}
        allr = {'workflow_runs': [{'created_at': '2026-10-14T01:00:00Z', 'run_number': 26},
                                  {'created_at': '2026-10-13T20:30:00Z', 'run_number': 23},
                                  {'created_at': '2026-10-13T01:00:00Z', 'run_number': 22}]}
        p, data, _ = self.run_cli(200, sched, '--watch', 'o/r:a.yml:0 20 * * *:6', all_body=allr)
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertEqual((data[0]['status'], data[0]['gaps']), ('suspect', [24, 25]))
        self.assertIn('断档', p.stdout)

    def test_contiguous_numbers_keep_overdue(self):
        sched = {'workflow_runs': [{'created_at': '2026-10-11T23:33:21Z', 'run_number': 21}]}
        allr = {'workflow_runs': [{'created_at': '2026-10-14T01:00:00Z', 'run_number': 24},
                                  {'created_at': '2026-10-13T20:30:00Z', 'run_number': 23},
                                  {'created_at': '2026-10-13T01:00:00Z', 'run_number': 22}]}
        p, data, _ = self.run_cli(200, sched, '--watch', 'o/r:a.yml:0 20 * * *:6', all_body=allr)
        self.assertEqual((data[0]['status'], data[0]['gaps']), ('overdue', []))

    def test_api_failure_is_unknown_not_ok(self):
        p, data, _ = self.run_cli(500, {'message': 'boom'}, '--watch', 'o/r:a.yml:0 20 * * *:6')
        self.assertEqual(p.returncode, 2)
        self.assertEqual(data[0]['status'], 'unknown')


if __name__ == '__main__':
    unittest.main()
