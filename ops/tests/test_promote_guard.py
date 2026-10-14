"""deploy.yml auto-promote-code 守卫（overview#555 方案 A，GUJI-214）。

两类检查，都不联网：
1. 行为：把守卫的 run 脚本从 deploy.yml 抽出来真跑，用假 `gh`（读本地夹具）顶替 GitHub API，
   覆盖「后面有部署类提交」时按 push run 状态决定让路／自己 promote。
2. 对拍：守卫里手写的路径正则必须与 on.push.paths 同口径（注释里的「改一处要改两处」），改一边没改另一边就红。
"""
import json
import os
import re
import subprocess
import tempfile
import unittest

try:
    import yaml
except ImportError:
    yaml = None

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
DEPLOY = os.path.join(ROOT, '.github', 'workflows', 'deploy.yml')
STEP = 'Auto-promote code only to production (from this run)'

FAKE_GH = r'''#!/usr/bin/env python3
import json, os, subprocess, sys
args = sys.argv[1:]
d = os.environ['FAKE_DIR']
with open(os.path.join(d, 'calls.log'), 'a') as f:
    f.write(' '.join(args) + '\n')
if args[:2] == ['workflow', 'run']:
    sys.exit(0)
assert args[0] == 'api', args
path, jq = args[1], None
if '--jq' in args:
    jq = args[args.index('--jq') + 1]
if path.endswith('/commits/main'):
    name = 'head.json'
elif '/compare/' in path:
    name = 'compare.json'
elif '/actions/workflows/deploy.yml/runs' in path:
    # runs-N.json 按第 N 次查询返回（模拟 run 晚几秒才出现）；超出取最后一份
    n = os.path.join(d, 'runs.count')
    i = int(open(n).read()) + 1 if os.path.exists(n) else 1
    open(n, 'w').write(str(i))
    cands = sorted(x for x in os.listdir(d) if x.startswith('runs-'))
    name = cands[min(i, len(cands)) - 1]
else:
    sys.exit(1)
raw = open(os.path.join(d, name)).read()
if raw.strip() == 'FAIL':
    sys.exit(1)
if jq == '.sha':
    print(json.loads(raw)['sha'])
else:
    print(subprocess.run(['jq', '-r', jq], input=raw, capture_output=True, text=True, check=True).stdout, end='')
'''


def _guard():
    with open(DEPLOY, encoding='utf-8') as f:
        wf = yaml.safe_load(f)
    step = [s for s in wf['jobs']['auto-promote-code']['steps'] if s.get('name') == STEP]
    assert len(step) == 1
    return step[0]['run'], wf


@unittest.skipIf(yaml is None, 'PyYAML 未安装')
class GuardBehavior(unittest.TestCase):
    RUN = 'a' * 40
    HEAD = 'c' * 40
    MID = 'b' * 40

    def run_guard(self, files, runs, head=None, commits=None, compare_fail=False):
        """runs：list，每项是一次查询返回的 workflow_runs（list of (sha, status, conclusion)）。"""
        script, _ = _guard()
        with tempfile.TemporaryDirectory() as d:
            bindir = os.path.join(d, 'bin')
            os.mkdir(bindir)
            gh = os.path.join(bindir, 'gh')
            with open(gh, 'w') as f:
                f.write(FAKE_GH)
            os.chmod(gh, 0o755)
            head = head or self.HEAD
            json.dump({'sha': head}, open(os.path.join(d, 'head.json'), 'w'))
            if compare_fail:
                open(os.path.join(d, 'compare.json'), 'w').write('FAIL')
            else:
                json.dump({'files': [{'filename': f} for f in files],
                           'commits': [{'sha': c} for c in (commits or [self.MID, self.HEAD])]},
                          open(os.path.join(d, 'compare.json'), 'w'))
            for i, rs in enumerate(runs, 1):
                if rs == 'FAIL':
                    open(os.path.join(d, 'runs-%d.json' % i), 'w').write('FAIL')
                else:
                    json.dump({'workflow_runs': [{'head_sha': s, 'status': st, 'conclusion': c} for s, st, c in rs]},
                              open(os.path.join(d, 'runs-%d.json' % i), 'w'))
            summary = os.path.join(d, 'summary.md')
            env = dict(os.environ, PATH=bindir + os.pathsep + os.environ['PATH'], FAKE_DIR=d,
                       GITHUB_REPOSITORY='o/r', GITHUB_RUN_ID='4242', GITHUB_STEP_SUMMARY=summary,
                       RUN_SHA=self.RUN, WAIT_SECS='3', POLL_SECS='1')
            r = subprocess.run(['bash', '--noprofile', '--norc', '-eo', 'pipefail', '-c', script],
                               env=env, capture_output=True, text=True, timeout=60)
            calls = open(os.path.join(d, 'calls.log')).read().splitlines() if os.path.exists(os.path.join(d, 'calls.log')) else []
            promoted = any(c.startswith('workflow run deploy.yml') and 'from_run=4242' in c for c in calls)
            return r, promoted, calls

    def test_head_equals_run_promotes(self):
        r, promoted, _ = self.run_guard(['src/a.ts'], [], head=self.RUN)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertTrue(promoted)

    def test_only_nondeploy_files_promotes_without_run_lookup(self):
        r, promoted, calls = self.run_guard(['README.md', '.github/workflows/test.yml', 'ops/x.py'], [])
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertTrue(promoted)
        self.assertFalse(any('/actions/workflows/' in c for c in calls))

    def test_successor_running_yields(self):
        r, promoted, _ = self.run_guard(['src/a.ts'], [[(self.HEAD, 'in_progress', None)]])
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertFalse(promoted)

    def test_successor_queued_yields(self):
        _, promoted, _ = self.run_guard(['src/a.ts'], [[(self.HEAD, 'queued', None)]])
        self.assertFalse(promoted)

    def test_successor_succeeded_yields(self):
        _, promoted, _ = self.run_guard(['src/a.ts'], [[(self.HEAD, 'completed', 'success')]])
        self.assertFalse(promoted)

    def test_all_successors_failed_or_cancelled_promotes(self):
        # #784 型：接手的 run 自己没成，本 run 验过的版本不能跟着丢
        _, promoted, _ = self.run_guard(['src/a.ts'], [[(self.MID, 'completed', 'cancelled'), (self.HEAD, 'completed', 'failure')]])
        self.assertTrue(promoted)

    def test_one_alive_among_dead_yields(self):
        _, promoted, _ = self.run_guard(['src/a.ts'], [[(self.MID, 'completed', 'cancelled'), (self.HEAD, 'in_progress', None)]])
        self.assertFalse(promoted)

    def test_unrelated_runs_do_not_count(self):
        # 列表里只有别的提交（含本 run 自己）的 run：等满后判「没人接手」
        r, promoted, calls = self.run_guard(['src/a.ts'], [[(self.RUN, 'completed', 'success'), ('d' * 40, 'in_progress', None)]])
        self.assertTrue(promoted)
        self.assertGreaterEqual(len([c for c in calls if '/actions/workflows/' in c]), 3)   # 轮询过

    def test_run_appearing_late_is_waited_for(self):
        r, promoted, calls = self.run_guard(['src/a.ts'], [[], [], [(self.HEAD, 'in_progress', None)]])
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertFalse(promoted)
        self.assertEqual(len([c for c in calls if '/actions/workflows/' in c]), 3)

    def test_wait_is_bounded(self):
        _, promoted, calls = self.run_guard(['src/a.ts'], [[]])
        self.assertTrue(promoted)
        self.assertLessEqual(len([c for c in calls if '/actions/workflows/' in c]), 5)   # WAIT 3 秒／间隔 1 秒

    def test_run_list_api_failure_keeps_old_behavior_yield(self):
        _, promoted, _ = self.run_guard(['src/a.ts'], ['FAIL'])
        self.assertFalse(promoted)

    def test_compare_failure_keeps_old_behavior_yield(self):
        _, promoted, _ = self.run_guard([], [], compare_fail=True)
        self.assertFalse(promoted)

    def test_deploy_yml_change_counts_as_trigger(self):
        _, promoted, _ = self.run_guard(['.github/workflows/deploy.yml'], [[(self.HEAD, 'completed', 'failure')]])
        self.assertTrue(promoted)   # 触发类，但接手者失败 → 自己发
        _, promoted, _ = self.run_guard(['.github/workflows/deploy.yml'], [[(self.HEAD, 'queued', None)]])
        self.assertFalse(promoted)


def _glob_to_re(pat):
    out, i = '', 0
    while i < len(pat):
        if pat.startswith('**/', i):
            out += '(?:.*/)?'; i += 3
        elif pat.startswith('**', i):
            out += '.*'; i += 2
        elif pat[i] == '*':
            out += '[^/]*'; i += 1
        else:
            out += re.escape(pat[i]); i += 1
    return re.compile('^' + out + '$')


def _push_triggers(patterns, path):
    """GitHub paths 语义：按顺序，最后一个匹配的模式决定（! 开头为排除）。"""
    res = False
    for p in patterns:
        neg = p.startswith('!')
        if _glob_to_re(p[1:] if neg else p).match(path):
            res = not neg
    return res


def _guard_regexes(script):
    """取出守卫里的两条 grep -vE 正则：(排除类, ^\\.github/)。"""
    m = re.search(r"grep -vE '\^\$' \| grep -vE '(\(.*?\))' \| grep -vE '(\^\\\.github/)'", script)
    assert m, '守卫里的路径过滤写法变了，请同步本测试'
    return m.group(1), m.group(2)


def _guard_triggers(script, path):
    excl, gh = _guard_regexes(script)
    if path == '.github/workflows/deploy.yml':
        return True
    return not re.search(excl, path) and not re.search(gh, path)


def _samples_from_glob(p):
    p = p[1:] if p.startswith('!') else p
    outs = {p.replace('**/', 'a/b/').replace('**', 'x/y').replace('*', 'x')}
    outs.add(p.replace('**/', '').replace('**', 'x').replace('*', 'x'))
    return outs


def _samples_from_regex(alt):
    """从正则的每个分支造样本：^ 开头的是根目录锚定，只造根目录样本；$ 结尾的后缀类前面补 x；以 / 结尾的目录类后面补 x。"""
    parts = re.split(r'\|(?![^(]*\))', alt.strip('()') if alt.startswith('(') and alt.endswith(')') else alt)
    outs = set()
    for a in parts:
        anchored = a.startswith('^')
        m = re.search(r'\((.*?)\)', a)
        variants = [a.replace(m.group(0), v) for v in m.group(1).split('|')] if m else [a]
        for v in variants:
            suffix = v.endswith('$') and v.startswith('\\.')
            v = v.replace('\\.', '.').lstrip('^').rstrip('$')
            if suffix:
                v = 'x' + v
            elif v.endswith('/'):
                v = v + 'x'
            outs.add(v)
            if not anchored:
                outs.add('a/b/' + v)
    return outs


@unittest.skipIf(yaml is None, 'PyYAML 未安装')
class GuardRegexMatchesPushPaths(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.script, wf = _guard()
        on = wf.get('on', wf.get(True))   # PyYAML 会把键 on 读成 True
        cls.paths = on['push']['paths']

    def test_every_sample_classified_the_same(self):
        samples = {'src/app.ts', 'package.json', 'pages/index.tsx', 'edge-functions/api/version.js', 'public/a.json',
                   'README.md', 'a/b/c.md', 'docs/x', 'e2e/t.spec.ts', 'ops/x.py', 'indexer/x.mjs', 'perf/g.ts',
                   '.claude/x', 'src/__tests__/a.ts', 'src/a.test.ts', 'src/a.test.tsx', 'src/a.test.mjs',
                   '.github/workflows/test.yml', '.github/workflows/deploy.yml', 'src/a.testx.ts', 'documents/a.ts'}
        for p in self.paths:
            samples |= _samples_from_glob(p)
        excl, _ = _guard_regexes(self.script)
        samples |= _samples_from_regex(excl)
        bad = [(s, _push_triggers(self.paths, s), _guard_triggers(self.script, s))
               for s in sorted(samples) if _push_triggers(self.paths, s) != _guard_triggers(self.script, s)]
        self.assertEqual(bad, [], '守卫正则与 on.push.paths 口径不一致（路径, push 触发?, 守卫认为触发?）')

    def test_sampler_sees_every_exclusion(self):
        # 防测试自己失灵：paths 里每条排除都至少生成了一个「push 不触发」的样本，正则里每个分支也是
        for p in self.paths:
            if p.startswith('!') and p != '!.github/**':
                self.assertTrue(any(not _push_triggers(self.paths, s) for s in _samples_from_glob(p)), p)
        excl, _ = _guard_regexes(self.script)
        self.assertTrue(all(not _guard_triggers(self.script, s) for s in _samples_from_regex(excl)))

    def test_detects_drift(self):
        # 自检：paths 多一条排除而正则没跟，必须被抓到
        drifted = self.paths + ['!extra/**']
        self.assertNotEqual(_push_triggers(drifted, 'extra/x.ts'), _guard_triggers(self.script, 'extra/x.ts'))
        # 反过来：正则多一支而 paths 没跟
        script2 = self.script.replace('^perf/|', '^perf/|^extra/|', 1)
        self.assertNotEqual(_push_triggers(self.paths, 'extra/x.ts'), _guard_triggers(script2, 'extra/x.ts'))


if __name__ == '__main__':
    unittest.main()
