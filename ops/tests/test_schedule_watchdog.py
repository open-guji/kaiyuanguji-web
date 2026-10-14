"""ops/schedule_watchdog.py：定时"该跑未跑"判断（GUJI-143）。不联网：gh 用假的脚本顶替。"""
import datetime as dt
import importlib.util
import json
import os
import stat
import subprocess
import sys
import tempfile
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

    def test_rejects_unsupported_cron(self):
        for bad in ('7 * * * *', '*/5 * * * *', '30 20 * * 1', 'x y * * *', '70 20 * * *', '0 25 * * *', ''):
            with self.assertRaises(ValueError, msg=bad):
                sw.parse_cron(bad)


class Cli(unittest.TestCase):
    def run_cli(self, gh_body, *extra):
        d = tempfile.mkdtemp()
        gh = os.path.join(d, 'fakegh')
        with open(gh, 'w') as f:
            f.write('#!/bin/sh\n' + gh_body + '\n')
        os.chmod(gh, os.stat(gh).st_mode | stat.S_IEXEC)
        out = os.path.join(d, 'out.json')
        env = dict(os.environ, GH_BIN=gh)
        p = subprocess.run([sys.executable, '-I', SCRIPT, '--now', '2026-10-14T05:00:00Z', '--out', out, *extra],
                           capture_output=True, text=True, env=env)
        data = None
        if os.path.exists(out):
            with open(out) as f:
                data = json.load(f)
        return p, data

    def test_overdue_listed_and_exit_zero(self):
        p, data = self.run_cli('echo \'["2026-10-11T23:33:21Z"]\'', '--watch', 'o/r:a.yml:0 20 * * *:6')
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertEqual([(r['key'], r['status']) for r in data], [('o/r/a.yml', 'overdue')])
        self.assertIn('overdue', p.stdout)

    def test_gh_failure_is_unknown_not_ok(self):
        p, data = self.run_cli('echo boom >&2; exit 1', '--watch', 'o/r:a.yml:0 20 * * *:6')
        self.assertEqual(p.returncode, 2)
        self.assertEqual(data[0]['status'], 'unknown')


if __name__ == '__main__':
    unittest.main()
