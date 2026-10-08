"""data.yml 的一致性检查（overview#470 P1）。

数据流程默认**只做检查**，只有「发布闸」放行才上传；与 deploy.yml 并行跑，所以并发组、触发、步骤顺序、
「只报告」的步骤、密钥的范围、发布闸的放行条件都钉住，免得以后改着改着悄悄变成会往正式前缀写的流程。
"""
import itertools
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
DATA = os.path.join(ROOT, '.github', 'workflows', 'data.yml')
VERIFY = os.path.join(ROOT, 'ops', 'data-package-verify.sh')


@unittest.skipIf(yaml is None, 'PyYAML 未安装')
class DataWorkflowCheckOnly(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with open(DATA, encoding='utf-8') as f:
            cls.raw = f.read()
        cls.wf = yaml.safe_load(cls.raw)
        cls.steps = cls.wf['jobs']['package']['steps']
        cls.names = [s.get('name', '') for s in cls.steps]

    def _step(self, name):
        hits = [s for s in self.steps if s.get('name') == name]
        self.assertEqual(len(hits), 1, name)
        return hits[0]

    def _gated(self, step, seen=None):
        """步骤是否受发布闸控制：if 里直接写了闸，或依赖了某个（递归地）受闸控制的步骤的输出／结果"""
        gate = "steps.gate.outputs.publish == 'true'"
        cond = str(step.get('if', ''))
        if gate in cond:
            return True
        by_id = {x.get('id'): x for x in self.steps if x.get('id')}
        seen = (seen or set()) | {step.get('id')}
        for ref in re.findall(r'steps\.([A-Za-z0-9_]+)\.', cond):
            if ref in seen or ref == 'gate':
                continue
            if ref in by_id and self._gated(by_id[ref], seen):
                return True
        return False

    def test_secrets_only_in_step_env_of_gated_steps(self):
        # job／workflow 级 env 不带密钥：同一个 job 里会跑数据仓里的 build_derived.py（所选 ref 的代码），它不该读到
        self.assertNotIn('secrets.', str(self.wf.get('env', {})))
        self.assertNotIn('secrets.', str(self.wf['jobs']['package'].get('env', {})))
        self.assertNotIn('secrets.', str(self.wf['jobs']['check']))
        used = 0
        for s in self.steps:
            self.assertNotIn('secrets.', s.get('run', ''), s.get('name'))   # 不在脚本里直接展开
            self.assertNotIn('secrets.', str(s.get('with', {})), s.get('name'))
            if 'secrets.' in str(s.get('env', {})):
                used += 1
                self.assertTrue(self._gated(s), s.get('name'))
        self.assertGreaterEqual(used, 4)
        # 会跑数据仓代码或做检查的步骤一个密钥都没有
        for n in ('Clone index data repos', 'Build derived data (schema-v2)', 'Bundle data', 'Verify bundled data (basic gates)',
                  'Data package check (report-only, overview#470)', 'h1 entry vs current parity sampling (report-only, overview#470)'):
            self.assertNotIn('secrets.', str(self._step(n)), n)

    def test_no_pointer_writes_outside_sync_and_web_json_untouched(self):
        code = '\n'.join(l for l in self.raw.splitlines() if not l.lstrip().startswith('#'))
        self.assertNotIn('write-web-pointer', code)          # web.json 只归代码流程写
        self.assertNotIn('latest-only', code)                 # 「只改 webCommitId」是代码流程的事

    def test_every_cos_touching_step_is_gated(self):
        cos_scripts = ('sync-to-cos', 'sync-h1', 'cos-sync-decision', 'upload-sitemaps')
        found = 0
        for s in self.steps:
            text = str(s.get('run', ''))
            touches = any(w in text for w in cos_scripts) or 'COS_PATH_PREFIX' in str(s.get('env', {})) \
                or (str(s.get('uses', '')).startswith('actions/cache') and 'cos-' in str(s.get('with', {}).get('key', '')))
            if touches:
                found += 1
                self.assertTrue(self._gated(s), s.get('name'))
        self.assertGreaterEqual(found, 8)

    def test_publish_order(self):
        n = self.names
        order = ['Publish gate', 'Clone index data repos', 'Bundle data', 'Verify bundled data (basic gates)',
                 'Carry over webCommitId from live latest.json', 'Record previous h1 root',
                 'Decide COS data sync (skip when data unchanged)', 'COS sync state — restore',
                 'Sync data to Tencent COS — current/ + h1 entry, in parallel', 'Mark COS sync complete',
                 'Generate item sitemaps', 'Upload item sitemaps']
        idx = [n.index(x) for x in order]
        self.assertEqual(idx, sorted(idx), '发布步骤的顺序')
        # 先传数据、再传 sitemap；sitemap 上传在数据同步成功之后（同步失败时整个 job 停在同步那步）
        self.assertLess(n.index('Sync data to Tencent COS — current/ + h1 entry, in parallel'), n.index('Upload item sitemaps'))

    def test_state_cache_keys_match_deploy(self):
        # 整条表达式（含 target、bucket、run_id、attempt）逐字等于 deploy.yml 的，只把 target 的来源换成本流程的 inputs.target；
        # restore-keys 同理——第一次接管时才能继承 deploy.yml 最后一次的 state，两边也不会各写各的键
        with open(os.path.join(ROOT, '.github', 'workflows', 'deploy.yml'), encoding='utf-8') as f:
            deploy = f.read()
        mine = "${{ inputs.target || 'production' }}"
        theirs = '${{ needs.resolve.outputs.target }}'
        for step in ('COS sync state — restore', 'COS h1 state — restore', 'COS sync state — save', 'COS h1 state — save'):
            w = self._step(step)['with']
            for field in ('key', 'restore-keys'):
                if field not in w:
                    continue
                for line in [l.strip() for l in w[field].splitlines() if l.strip()]:
                    self.assertIn(line.replace(mine, theirs), deploy, (step, field, line))
            self.assertIn(mine, w['key'])

    def test_sync_uses_gate_prefix_and_two_routes_only(self):
        s = self._step('Sync data to Tencent COS — current/ + h1 entry, in parallel')
        self.assertEqual(s['env']['COS_PATH_PREFIX'], '${{ steps.gate.outputs.prefix }}')
        self.assertIn('sync-to-cos.mjs', s['run'])
        self.assertIn('sync-h1-to-cos.mjs', s['run'])
        self.assertNotIn('bundle-hashed-text', s['run'])      # h1 文本是单独任务（设计 §5）
        self.assertIn('R_CUR" -ne 0', s['run'])                # current/ 失败整步失败

    def _run_carry(self, code, body, prefix=''):
        run = self._step('Carry over webCommitId from live latest.json')['run']
        with tempfile.TemporaryDirectory() as d:
            bindir = os.path.join(d, 'bin'); os.mkdir(bindir)
            root = os.path.join(d, 'root'); os.mkdir(root)
            with open(os.path.join(root, 'latest.json'), 'w') as f:
                f.write('{"productionCommitId": "p"}')
            with open(os.path.join(d, 'resp'), 'w') as f:
                f.write(body)
            # 假 curl：把预设响应写进 -o 指定的文件，在 stdout 打印状态码
            with open(os.path.join(bindir, 'curl'), 'w') as f:
                f.write('#!/bin/bash\nwhile [ $# -gt 0 ]; do [ "$1" = -o ] && { cp "%s" "$2"; }; shift; done\nprintf %%s "%s"\n' % (os.path.join(d, 'resp'), code))
            os.chmod(os.path.join(bindir, 'curl'), 0o755)
            out = os.path.join(d, 'out'); open(out, 'w').close()
            env = dict(os.environ, PATH=bindir + os.pathsep + os.environ['PATH'], PREFIX=prefix, RUNNER_TEMP=d,
                       KYG_DATA_ROOT=root, GITHUB_OUTPUT=out)
            r = subprocess.run(['bash', '-e', '-c', run], env=env, capture_output=True, text=True, timeout=30)
            with open(os.path.join(root, 'latest.json')) as f:
                latest = f.read()
            with open(out) as f:
                outputs = dict(l.split('=', 1) for l in f.read().splitlines() if '=' in l)
            return r.returncode, json.loads(latest), outputs

    def test_carry_over_keeps_web_commit_id(self):
        s = self._step('Carry over webCommitId from live latest.json')
        self.assertIn("steps.gate.outputs.sitemaps_only != 'true'", s['if'])
        w = 'a1' * 20
        rc, latest, out = self._run_carry('200', json.dumps({'webCommitId': w, 'productionCommitId': 'old'}))
        self.assertEqual((rc, latest.get('webCommitId'), out.get('web_commit')), (0, w, w))
        self.assertEqual(latest['productionCommitId'], 'p')                       # 只带 webCommitId，其它字段用新打包的
        rc, latest, out = self._run_carry('200', json.dumps({'productionCommitId': 'old'}))   # 老指针没有该字段
        self.assertEqual((rc, 'webCommitId' in latest, out.get('web_commit')), (0, False, ''))
        rc, latest, out = self._run_carry('404', '')                              # 首次发布
        self.assertEqual((rc, 'webCommitId' in latest, out.get('web_commit')), (0, False, ''))

    def test_carry_over_refuses_to_publish_when_live_pointer_unreadable(self):
        for code, body in (('500', ''), ('000', ''), ('403', 'x'), ('200', 'not json'), ('200', '[1]'),
                           ('200', json.dumps({'webCommitId': 'short'}))):
            rc, latest, out = self._run_carry(code, body)
            self.assertNotEqual(rc, 0, (code, body))
            self.assertNotIn('webCommitId', latest, (code, body))

    def test_marker_only_after_full_success_and_gets_web_commit(self):
        s = self._step('Mark COS sync complete')
        self.assertEqual(s['if'], "${{ steps.cos_sync.outputs.all_ok == 'true' }}")
        self.assertIn('steps.carry.outputs.web_commit', s['env']['WEB_COMMIT_ID'])

    def test_sitemap_steps_condition(self):
        g = self._step('Generate item sitemaps')['if']
        expr = re.sub(r'^\$\{\{\s*|\s*\}\}$', '', g)
        def ev(publish, only, skip, present):
            vals = {'steps.gate.outputs.publish': publish, 'steps.gate.outputs.sitemaps_only': only,
                    'steps.cos_decide.outputs.skip': skip, 'steps.sm_present.outputs.present': present}
            py = expr
            for k, v in vals.items():
                py = py.replace(k, repr(v))
            return eval(py.replace('&&', ' and ').replace('||', ' or '), {})   # noqa: S307 — 受控的测试输入
        for publish, only, skip, present in itertools.product(('true', 'false'), ('true', 'false'), ('true', 'false', ''), ('true', 'false', '')):
            want = publish == 'true' and (only == 'true' or skip != 'true' or present != 'true')
            self.assertEqual(ev(publish, only, skip, present), want, (publish, only, skip, present))
        self.assertEqual(self._step('Generate item sitemaps')['env']['SITEMAP_SITE'], 'https://www.kaiyuanguji.com')
        # 「完整发布过」的判断带两个 commit，COS 密钥只在这一步的 step 级 env
        p = self._step('Check whether this sitemap version was fully published')
        self.assertIn('steps.clone.outputs.index_sha', p['env']['SITEMAP_META'])
        self.assertIn('steps.clone.outputs.text_sha', p['env']['SITEMAP_META'])
        self.assertIn('--check-meta', p['run'])

    # ---- 发布闸的行为：把 run 脚本抽出来，枚举所有输入组合 ----
    def _run_gate(self, target='production', only='false', override='false', split='', prod='main', text='main'):
        run = self._step('Publish gate')['run']
        with tempfile.TemporaryDirectory() as d:
            out = os.path.join(d, 'out'); summ = os.path.join(d, 'summary')
            open(out, 'w').close(); open(summ, 'w').close()
            env = dict(os.environ, TARGET=target, ONLY_SITEMAPS=only, ALLOW_OVERRIDE=override, SPLIT_VAR=split,
                       PROD_REF=prod, TEXT_REF=text, GITHUB_OUTPUT=out, GITHUB_STEP_SUMMARY=summ)
            r = subprocess.run(['bash', '-e', '-c', run], env=env, capture_output=True, text=True)
            self.assertEqual(r.returncode, 0, r.stderr)
            with open(out, encoding='utf-8') as fh:
                return dict(l.split('=', 1) for l in fh.read().splitlines() if '=' in l)

    def test_gate_named_cases(self):
        g = self._run_gate
        self.assertEqual(g()['publish'], 'false')                                         # 定时／默认：开关未设只检查
        o = g(split='true'); self.assertEqual((o['publish'], o['prefix'], o['sitemaps_only']), ('true', '', 'false'))
        self.assertEqual(g(split='true', prod='schema-v2')['publish'], 'false')           # 联调分支不上正式前缀
        self.assertEqual(g(split='true', text='x', override='true')['publish'], 'true')   # 回滚重发
        self.assertEqual(g(prod='x', override='true')['publish'], 'false')                # 没开关也不是 only_sitemaps：不放行
        o = g(target='staging'); self.assertEqual((o['publish'], o['prefix']), ('true', 'staging'))
        o = g(target='staging', prod='schema-v2'); self.assertEqual((o['publish'], o['prefix']), ('false', 'staging'))   # 非 main 的 ref 连 staging 也不发布
        o = g(target='staging', prod='schema-v2', override='true'); self.assertEqual((o['publish'], o['prefix']), ('true', 'staging'))
        o = g(only='true'); self.assertEqual((o['publish'], o['sitemaps_only'], o['prefix']), ('true', 'true', ''))
        self.assertEqual(g(only='true', prod='x')['publish'], 'false')
        o = g(target='staging', only='true'); self.assertEqual((o['publish'], o['sitemaps_only'], o['prefix']), ('true', 'true', 'staging'))

    def test_gate_never_opens_production_prefix_without_switch_or_sitemaps_only(self):
        # 不变式（枚举全部组合）：写正式前缀(prefix='')只可能是 ① 开关打开 ② only_sitemaps；refs 不是 main 时必须带 override；
        # target=staging 时前缀一定是 staging
        for target, only, override, split, prod, text in itertools.product(
                ('production', 'staging'), ('true', 'false'), ('true', 'false'), ('', 'true', 'false'), ('main', 'x'), ('main', 'y')):
            o = self._run_gate(target, only, override, split, prod, text)
            case = (target, only, override, split, prod, text, o)
            if target == 'staging':
                self.assertEqual(o['prefix'], 'staging', case)
                if o['publish'] == 'true' and (prod != 'main' or text != 'main'):
                    self.assertEqual(override, 'true', case)
                self.assertEqual(o['publish'], 'true' if (prod == 'main' and text == 'main') or override == 'true' else 'false', case)
                continue
            self.assertEqual(o['prefix'], '', case)
            if o['publish'] == 'true':
                self.assertTrue(split == 'true' or only == 'true', case)
                if prod != 'main' or text != 'main':
                    self.assertEqual(override, 'true', case)
                if only == 'true':
                    self.assertEqual(o['sitemaps_only'], 'true', case)

    # ---- 刷新、上线后抽查、告警（PR-C1）----
    def test_followup_jobs_exist_and_only_follow_real_data_publish(self):
        jobs = self.wf['jobs']
        for j in ('refresh', 'live-ref', 'verify-live', 'alert-data'):
            self.assertIn(j, jobs)
        for j in ('refresh', 'live-ref', 'verify-live'):
            self.assertIn("needs.package.outputs.data_published == 'true'", str(jobs[j]['if']), j)
        # current/ 同步没成功（跳过、失败、没放行）时 data_published 必须是 false
        self.assertEqual(self.wf['jobs']['package']['outputs']['data_published'], "${{ steps.cos_sync.outcome == 'success' }}")

    def test_only_check_and_alert_jobs_may_write_issues(self):
        self.assertEqual(self.wf['permissions'], {'contents': 'read'})
        for name, job in self.wf['jobs'].items():
            perms = job.get('permissions') or {}
            if name in ('check', 'alert-data'):
                self.assertEqual(perms, {'contents': 'read', 'issues': 'write'}, name)
            else:
                self.assertNotIn('issues', perms, name)

    def test_refresh_job_runs_no_data_repo_code_and_scopes_secrets(self):
        steps = self.wf['jobs']['refresh']['steps']
        text = str(steps)
        self.assertNotIn('clone_cached', text)
        self.assertNotIn('build_derived', text)
        self.assertNotIn('bundle-data', text)
        self.assertNotIn('secrets.', str(self.wf['jobs']['refresh'].get('env', {})))
        for st in steps:
            self.assertNotIn('secrets.', st.get('run', ''))
        # 页面失效与核对、清缓存都不拦（失效没生效最坏是 s-maxage 自然过期）
        for st in steps:
            if st.get('name', '').startswith(('Purge data pointers', 'Revalidate changed')):
                self.assertTrue(st.get('continue-on-error'), st['name'])
        purge = [st for st in steps if st.get('name', '').startswith('Purge data pointers')][0]
        self.assertIn('ops/purge-urls.py', purge['run'])
        self.assertNotIn('purge_host', purge['run'])   # 不清整站

    def test_verify_live_reuses_verify_workflow_with_read_links(self):
        v = self.wf['jobs']['verify-live']
        self.assertEqual(v['uses'], './.github/workflows/verify.yml')
        w = v['with']
        self.assertIs(w['read_links'], True)
        self.assertIs(w['wait_cdn'], True)
        self.assertEqual(w['target'], "${{ needs.package.outputs.prefix == 'staging' && 'staging' || 'production' }}")
        self.assertEqual(w['ref'], '${{ needs.live-ref.outputs.ref }}')
        self.assertIn('!cancelled()', v['if'])      # refresh 红了也要抽查

    def test_alert_only_for_production_prefix_failures(self):
        c = self.wf['jobs']['alert-data']['if']
        for needle in ("needs.package.outputs.publish == 'true'", "needs.package.outputs.prefix == ''",
                       "needs.package.outputs.sitemaps_only != 'true'", "needs.package.result == 'failure'",
                       "needs.verify-live.result == 'failure'"):
            self.assertIn(needle, c)

    def test_freshness_alarm_only_after_switch_and_scheduled(self):
        st = [x for x in self.wf['jobs']['check']['steps'] if x.get('name', '').startswith('Data freshness alarm')][0]
        self.assertIn("github.event_name == 'schedule'", st['if'])
        self.assertIn("vars.SPLIT_DATA_FLOW == 'true'", st['if'])
        self.assertTrue(st.get('continue-on-error'))
        self.assertEqual(st['env']['LAG_HOURS'], '36')
        self.assertIn('data-alert', st['run'])

    def test_refresh_and_live_ref_still_run_when_package_fails_after_data_synced(self):
        # current/ 同步成功之后 package 里 sitemap 等步骤红了，数据已经换上线：缓存照样要清、抽查照样要跑
        for j in ('refresh', 'live-ref'):
            c = self.wf['jobs'][j]['if']
            self.assertIn('!cancelled()', c, j)
            self.assertIn("needs.package.outputs.data_published == 'true'", c, j)
        self.assertIn('!cancelled()', self.wf['jobs']['verify-live']['if'])

    def test_refresh_reports_its_own_failures_to_the_alert(self):
        r = self.wf['jobs']['refresh']
        ok = r['outputs']['ok']
        for sid in ('purge', 'changes', 'reval'):
            self.assertIn(f"steps.{sid}.outcome != 'failure'", ok)
            self.assertTrue([x for x in r['steps'] if x.get('id') == sid], sid)
        self.assertIn("needs.refresh.outputs.ok == 'false'", self.wf['jobs']['alert-data']['if'])

    def test_control_ids_travel_with_the_item_changes_artifact(self):
        compute = [x for x in self.steps if x.get('id') == 'item_changes'][0]
        self.assertIn('control-ids.txt', compute['run'])
        up = [x for x in self.steps if x.get('name') == 'Upload item changes'][0]
        self.assertTrue(up['with']['path'].endswith('/item-artifact'))      # 目录：改动集和对照页候选一起带
        reval = [x for x in self.wf['jobs']['refresh']['steps'] if x.get('id') == 'reval'][0]
        self.assertIn('ITEM_CONTROL_IDS', reval['run'])
        self.assertIn('control-ids.txt', reval['run'])

    def _run_step(self, step, env, gh_script):
        with tempfile.TemporaryDirectory() as d:
            os.makedirs(os.path.join(d, 'bin'))
            log = os.path.join(d, 'gh.log')
            shim = os.path.join(d, 'bin', 'gh')
            with open(shim, 'w', encoding='utf-8') as fh:
                fh.write(gh_script.replace('LOG', log))
            os.chmod(shim, 0o755)
            summ = os.path.join(d, 'summary'); open(summ, 'w').close()
            e = dict(os.environ, PATH=os.path.join(d, 'bin') + ':' + os.environ['PATH'], GITHUB_STEP_SUMMARY=summ,
                     GITHUB_SERVER_URL='https://github.com', GITHUB_REPOSITORY='o/r', GITHUB_RUN_ID='1', **env)
            r = subprocess.run(['bash', '-e', '-c', step['run']], env=e, capture_output=True, text=True)
            self.assertEqual(r.returncode, 0, r.stderr)
            logged = ''
            if os.path.exists(log):
                with open(log, encoding='utf-8') as fh:
                    logged = fh.read()
            return r.stdout, logged

    GH_SHIM = '''#!/bin/bash
case "$*" in
  "api repos/open-guji/"*"/commits/"*) echo "2020-01-01T00:00:00Z" ;;
  "label create"*) ;;
  "issue list"*) echo "" ;;
  "issue create"*|"issue comment"*) echo "$@" >> LOG ;;
  *) echo "unexpected gh $*" >&2; exit 9 ;;
esac
'''

    def test_freshness_alarm_skips_when_live_pointer_unavailable(self):
        st = [x for x in self.wf['jobs']['check']['steps'] if x.get('name', '').startswith('Data freshness alarm')][0]
        base = dict(GH_TOKEN='x', GH_REPO='r', LAG_HOURS='36', HEAD_PROD='b' * 40, HEAD_TEXT='d' * 40)
        # 线上指针取不到（空）或不是完整 commit：不拿 HEAD 的年龄当落后的证据，不开 issue
        for live in ('', 'garbage', 'a' * 12):
            out, log = self._run_step(st, dict(base, LIVE_PROD=live, LIVE_TEXT=live), self.GH_SHIM)
            self.assertEqual(log, '', live)
        # 线上是有效 commit、且 HEAD 的提交早已过了 36 小时：开 issue
        out, log = self._run_step(st, dict(base, LIVE_PROD='a' * 40, LIVE_TEXT='c' * 40), self.GH_SHIM)
        self.assertIn('issue create', log)

    def _alert(self, **env):
        st = self.wf['jobs']['alert-data']['steps'][0]
        base = dict(GH_TOKEN='x', GH_REPO='r', PACKAGE='success', PUBLISHED='true', REFRESH_OK='true', VERIFY='success',
                    OLD_PROD='o' * 40, OLD_TEXT='p' * 40, NEW_PROD='n' * 40, NEW_TEXT='m' * 40)
        base.update(env)
        return self._run_step(st, base, self.GH_SHIM)[1]

    def test_alert_wording_follows_whether_data_was_actually_published(self):
        # 上传失败、数据没换：线上还是上一版
        t = self._alert(PACKAGE='failure', PUBLISHED='false')
        self.assertIn('数据发布失败', t); self.assertIn('还是上一版', t)
        # current/ 同步成功之后 package 才红（sitemap 等）：数据已经是新的，不能说"还是上一版"
        t = self._alert(PACKAGE='failure', PUBLISHED='true')
        self.assertIn('数据已换上线', t); self.assertNotIn('还是上一版', t); self.assertNotIn('这次没发上去', t)
        # 抽查失败
        self.assertIn('上线后抽查失败', self._alert(VERIFY='failure'))
        # 只有刷新失败：数据本身没问题
        t = self._alert(REFRESH_OK='false')
        self.assertIn('缓存刷新没完全生效', t); self.assertIn('数据本身没问题', t); self.assertNotIn('发布失败', t)
        # 几件事同时发生：都列出来
        t = self._alert(PACKAGE='failure', PUBLISHED='true', VERIFY='failure', REFRESH_OK='false')
        for w in ('数据已换上线', '上线后抽查失败', '缓存刷新没完全生效'):
            self.assertIn(w, t)
        # 任何一种都带回滚做法和新旧 commit
        for w in ('allow_ref_override', 'o' * 40, 'n' * 40):
            self.assertIn(w, t)

    def test_verify_workflow_has_read_links_input(self):
        with open(os.path.join(ROOT, '.github', 'workflows', 'verify.yml'), encoding='utf-8') as f:
            wf = yaml.safe_load(f)
        on = wf.get('on') or wf.get(True)
        for trig in ('workflow_call', 'workflow_dispatch'):
            self.assertIn('read_links', on[trig]['inputs'], trig)
            self.assertIs(on[trig]['inputs']['read_links']['default'], False, trig)
        self.assertEqual(wf['jobs']['read-links']['if'],
                         "${{ inputs.target == 'staging' || inputs.full_suite || inputs.read_links }}")

    def test_read_only_permissions(self):
        self.assertEqual(self.wf['permissions'], {'contents': 'read'})

    def test_concurrency_publish_data_not_cancelling(self):
        c = self.wf['concurrency']
        self.assertEqual(c['group'], 'publish-data')
        self.assertFalse(c['cancel-in-progress'])

    def test_scheduled_check_always_runs_once_switch_on(self):
        run = self.wf['jobs']['check']['steps'][0]['run']
        def go(split):
            with tempfile.TemporaryDirectory() as d:
                out = os.path.join(d, 'out'); open(out, 'w').close()
                env = dict(os.environ, SPLIT_VAR=split, GITHUB_OUTPUT=out)
                # 把 ${{ github.event_name }} 换成 schedule；开关打开时必须在碰网络之前就决定
                r = subprocess.run(['bash', '-e', '-c', run.replace('${{ github.event_name }}', 'schedule')], env=env, capture_output=True, text=True, timeout=20)
                self.assertEqual(r.returncode, 0, r.stderr)
                with open(out, encoding='utf-8') as fh:
                    return fh.read().strip()
        self.assertEqual(go('true'), 'should_run=true')

    def test_triggers_schedule_and_manual(self):
        on = self.wf.get('on', self.wf.get(True))
        self.assertIn('schedule', on)
        self.assertIn('workflow_dispatch', on)
        self.assertNotIn('push', on)

    def test_order_clone_derive_bundle_verify_check(self):
        order = ['Clone index data repos', 'Build derived data (schema-v2)', 'Bundle data',
                 'Verify bundled data (basic gates)', 'Data package check (report-only, overview#470)']
        idx = [self.names.index(n) for n in order]
        self.assertEqual(idx, sorted(idx))

    def test_report_only_steps_do_not_block(self):
        for n in ('Data package check (report-only, overview#470)',
                  'h1 entry vs current parity sampling (report-only, overview#470)'):
            self.assertTrue(self._step(n).get('continue-on-error'), n)
        self.assertNotIn('--enforce', self._step('Data package check (report-only, overview#470)')['run'])

    def test_basic_gates_use_shared_script(self):
        self.assertIn('ops/data-package-verify.sh', self._step('Verify bundled data (basic gates)')['run'])
        self.assertTrue(os.path.isfile(VERIFY))
        self.assertTrue(os.access(VERIFY, os.X_OK), 'ops/data-package-verify.sh 要有执行位')

    def test_verify_script_keeps_deploy_thresholds(self):
        with open(VERIFY, encoding='utf-8') as f:
            sh = f.read()
        self.assertRegex(sh, r'N_ENTRY"? -lt 100000')
        for needle in ('book-text-private', 'Stale chunks', 'index/collections.json'):
            self.assertIn(needle, sh)

    def test_data_ref_validation_same_as_deploy(self):
        run = self._step('Check data repo refs')['run']
        self.assertIn('git check-ref-format', run)
        self.assertRegex(run, re.escape("^[A-Za-z0-9._/-]+$"))

    def test_checkout_does_not_persist_token(self):
        # build_derived.py 来自所选 ref 的数据仓，不能让它读到工作区 git 配置里的令牌
        co = [s for s in self.steps if str(s.get('uses', '')).startswith('actions/checkout')]
        self.assertTrue(co)
        for s in co:
            self.assertIs(s.get('with', {}).get('persist-credentials'), False)

    def test_ls_remote_failure_does_not_fail_check(self):
        run = self.wf['jobs']['check']['steps'][0]['run']
        self.assertEqual(run.count('git ls-remote'), 2)
        for line in run.splitlines():
            if 'git ls-remote' in line:
                self.assertIn('|| true', line)

    def test_clone_uses_cache_and_shared_script(self):
        names = self.names
        for repo in ('book-index', 'book-text'):
            self.assertLess(names.index(f'Restore git cache — {repo}'), names.index('Clone index data repos'))
            self.assertGreater(names.index(f'Save git cache — {repo}'), names.index('Clone index data repos'))
            for n in (f'Restore git cache — {repo}', f'Save git cache — {repo}'):
                self.assertTrue(self._step(n).get('continue-on-error'), n)
                self.assertTrue(self._step(n)['with']['path'].endswith('/.git'))
        run = self._step('Clone index data repos')['run']
        self.assertIn('source ops/clone-cached.sh', run)
        self.assertEqual(run.count('clone_cached '), 2)
        self.assertTrue(os.path.isfile(os.path.join(ROOT, 'ops', 'clone-cached.sh')))

    def test_long_steps_print_duration(self):
        for needle in ('✔ build_derived 用时', '✔ 打包数据用时'):
            self.assertIn(needle, self.raw)


if __name__ == '__main__':
    unittest.main()
