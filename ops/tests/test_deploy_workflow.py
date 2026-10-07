"""deploy.yml 的一致性检查（overview#341）。

正式站的全栈构建在 deploy.yml 里有两份：build 任务（手动 promote、不带产物时重新构建）与
prod-artifact 任务（push 时与测试站并行构建、存成工件供 promote 直接部署）。两份的 env 与命令
必须一字不差，否则「测试站验过的那份正式站产物」与「重新构建的正式站」配置不同，问题只会在正式站暴露。
"""
import os
import unittest

try:
    import yaml
except ImportError:  # rollback.yml 等处 discover 整个目录时，没装 PyYAML 就跳过
    yaml = None

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
DEPLOY = os.path.join(ROOT, '.github', 'workflows', 'deploy.yml')
STEP = 'Build for EdgeOne (production, fullstack → kyg-ssr-spike)'


def _step(job, name):
    hits = [s for s in job['steps'] if s.get('name') == name]
    if len(hits) != 1:
        raise AssertionError(f'{name!r} 应恰好一步，实际 {len(hits)}')
    return hits[0]


@unittest.skipIf(yaml is None, 'PyYAML 未安装')
class ProductionBuildParity(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with open(DEPLOY, encoding='utf-8') as f:
            cls.wf = yaml.safe_load(f)

    def test_prod_artifact_job_exists(self):
        self.assertIn('prod-artifact', self.wf['jobs'])

    def test_env_identical(self):
        a = _step(self.wf['jobs']['build'], STEP)
        b = _step(self.wf['jobs']['prod-artifact'], STEP)
        self.assertEqual(a['env'], b['env'])

    def test_run_identical(self):
        a = _step(self.wf['jobs']['build'], STEP)
        b = _step(self.wf['jobs']['prod-artifact'], STEP)
        self.assertEqual(a['run'], b['run'])

    def test_artifact_is_encrypted_before_upload(self):
        steps = self.wf['jobs']['prod-artifact']['steps']
        names = [s.get('name', '') for s in steps]
        self.assertLess(names.index('Pack production artifact (encrypted)'), names.index('Upload production artifact'))
        up = _step(self.wf['jobs']['prod-artifact'], 'Upload production artifact')
        self.assertNotIn('.edgeone', up['with']['path'].replace('prod-edgeone.tgz.enc', ''))


@unittest.skipIf(yaml is None, 'PyYAML 未安装')
class CosSyncStateCache(unittest.TestCase):
    """overview#410：sync-to-cos 的 .sync-state.json 进 actions/cache。键必须带目标站和桶名哈希，存取路径一致，
    恢复在同步之前、保存在同步之后，否则测试站与正式站的状态会互相污染，或者缓存根本没起作用。"""

    @classmethod
    def setUpClass(cls):
        with open(DEPLOY, encoding='utf-8') as f:
            cls.steps = yaml.safe_load(f)['jobs']['build']['steps']
        cls.names = [x.get('name', '') for x in cls.steps]

    def _by_prefix(self, prefix):
        return [x for x in self.steps if x.get('name', '').startswith(prefix)][0]

    def test_order(self):
        sync = [i for i, n in enumerate(self.names) if n.startswith('Sync data to Tencent COS')][0]
        restore = [i for i, n in enumerate(self.names) if n.startswith('COS sync state — restore')][0]
        save = [i for i, n in enumerate(self.names) if n.startswith('COS sync state — save')][0]
        self.assertLess(restore, sync)
        self.assertLess(sync, save)

    def test_keys_and_paths(self):
        restore = self._by_prefix('COS sync state — restore')['with']
        save = self._by_prefix('COS sync state — save')['with']
        self.assertEqual(restore['path'], 'nextjs/.next/.sync-state.json')
        self.assertEqual(save['path'], restore['path'])
        for k in (restore['key'], save['key']):
            self.assertIn('needs.resolve.outputs.target', k)
            self.assertIn('cos_state_key.outputs.bucket', k)
        for k in (restore['key'], save['key']):
            self.assertIn('github.run_attempt', k)  # 重跑不命中自己当年存的旧状态
        self.assertTrue(save['key'].startswith(restore['restore-keys'].strip()))
        self.assertTrue(restore['key'].startswith(restore['restore-keys'].strip()))


@unittest.skipIf(yaml is None, 'PyYAML 未安装')
class CosH1StateCache(unittest.TestCase):
    """第二轮提速：h1 条目／h1 文本两路同步的 state 也进 actions/cache（同 overview#410 的做法）。
    键必须带目标站和桶名哈希；只在三路都成功（all_ok）后才存，免得把中途失败的旧 state 传给下一次；
    夜间数据发布（定时测试站、正式站 promote=data）强制重建 state（SYNC_REBUILD_STATE=1）。"""

    PATHS = 'nextjs/.next/.sync-h1-state.json\nnextjs/.next/.sync-h1-text-state.json'

    @classmethod
    def setUpClass(cls):
        with open(DEPLOY, encoding='utf-8') as f:
            cls.steps = yaml.safe_load(f)['jobs']['build']['steps']
        cls.names = [x.get('name', '') for x in cls.steps]

    def _idx(self, prefix):
        return [i for i, n in enumerate(self.names) if n.startswith(prefix)][0]

    def test_order(self):
        sync = self._idx('Sync data to Tencent COS')
        self.assertLess(self._idx('COS h1 state — restore'), sync)
        self.assertLess(sync, self._idx('COS h1 state — save'))

    def test_keys_and_paths(self):
        restore = self.steps[self._idx('COS h1 state — restore')]['with']
        save = self.steps[self._idx('COS h1 state — save')]['with']
        self.assertEqual(restore['path'].strip(), self.PATHS)
        self.assertEqual(save['path'].strip(), self.PATHS)
        for k in (restore['key'], save['key']):
            self.assertIn('needs.resolve.outputs.target', k)
            self.assertIn('cos_state_key.outputs.bucket', k)
            self.assertIn('github.run_attempt', k)
        self.assertTrue(save['key'].startswith(restore['restore-keys'].strip()))
        self.assertTrue(restore['key'].startswith(restore['restore-keys'].strip()))
        # 与 current/ 的缓存分开命名，互不顶替
        self.assertFalse(restore['restore-keys'].strip().startswith('cos-sync-state-'))

    def test_save_only_when_all_three_ok(self):
        save = self.steps[self._idx('COS h1 state — save')]
        self.assertIn("steps.cos_sync.outputs.all_ok == 'true'", save['if'])

    def test_scheduled_run_rebuilds_state(self):
        sync = self.steps[self._idx('Sync data to Tencent COS')]
        e = sync['env']['SYNC_REBUILD_STATE']
        self.assertIn("github.event_name == 'schedule'", e)
        self.assertIn("'1'", e)
        # 自动派的正式站 promote=data 是单独的 dispatch，要单列；code+data 的 promote（push 路径）不重建
        self.assertIn("inputs.target == 'production'", e)
        self.assertIn("inputs.promote == 'data'", e)


@unittest.skipIf(yaml is None, 'PyYAML 未安装')
class CloneCacheAndProgress(unittest.TestCase):
    """overview#470 P1：克隆缓存（restore → clone → save）与长步骤的进度日志。"""

    @classmethod
    def setUpClass(cls):
        with open(DEPLOY, encoding='utf-8') as f:
            cls.raw = f.read()
        cls.wf = yaml.safe_load(cls.raw)

    def test_build_job_cache_steps_order_and_gating(self):
        steps = self.wf['jobs']['build']['steps']
        names = [x.get('name', '') for x in steps]
        for repo in ('book-index', 'book-text'):
            r, c, sv = f'Restore git cache — {repo}', 'Clone index data repos', f'Save git cache — {repo}'
            self.assertLess(names.index(r), names.index(c))
            self.assertLess(names.index(c), names.index(sv))
            for n in (r, sv):
                st = steps[names.index(n)]
                self.assertIn('DATA_FAST', st['if'], n)
                self.assertTrue(st.get('continue-on-error'), f'{n} 失败不能拦发布')
        # 保存只在没精确命中时做，键用实际取到的 commit
        sv = steps[names.index('Save git cache — book-text')]
        self.assertIn("cache-hit != 'true'", sv['if'])
        self.assertIn('steps.clone.outputs.text_sha', sv['with']['key'])

    def test_cache_path_is_git_dir_only(self):
        for st in self.wf['jobs']['build']['steps']:
            if str(st.get('name', '')).startswith(('Restore git cache', 'Save git cache')):
                self.assertTrue(st['with']['path'].endswith('/.git'), st['name'])

    def test_prod_artifact_clone_cache_only_on_sitemap_cache_miss(self):
        steps = self.wf['jobs']['prod-artifact']['steps']
        names = [x.get('name', '') for x in steps]
        i = names.index('Clone, bundle and generate item sitemaps (cache miss)')
        self.assertLess(names.index('Restore git cache — book-text'), i)
        self.assertGreater(names.index('Save git cache — book-text'), i)
        self.assertEqual(steps[i].get('id'), 'gen')
        self.assertIn("sitemap_cache.outputs.cache-hit != 'true'", steps[names.index('Restore git cache — book-text')]['if'])

    def test_heartbeat_uses_progress_script_with_fallback(self):
        self.assertIn('scripts/sync-heartbeat.mjs', self.raw)
        self.assertNotIn('current/ pid $P_CUR', self.raw)

    def test_long_steps_print_start_end_and_duration(self):
        for needle in ('▶ build_derived 开始', '✔ build_derived 用时', '▶ 打包数据开始', '✔ 打包数据用时',
                       '▶ EdgeOne 全栈构建开始', '✔ EdgeOne 全栈构建用时',
                       '▶ EdgeOne 部署（测试站）开始', '✔ EdgeOne 部署（测试站）用时',
                       '▶ EdgeOne 部署（正式站）开始', '✔ EdgeOne 部署（正式站）用时'):
            self.assertIn(needle, self.raw, needle)


@unittest.skipIf(yaml is None, 'PyYAML 未安装')
class WebPointerStep(unittest.TestCase):
    """overview#470 P1：代码指针 web.json 在部署成功之后、清缓存之前写，不拦发布，清缓存带上它。"""

    @classmethod
    def setUpClass(cls):
        with open(DEPLOY, encoding='utf-8') as f:
            cls.raw = f.read()
        cls.wf = yaml.safe_load(cls.raw)
        cls.steps = cls.wf['jobs']['build']['steps']
        cls.names = [s.get('name', '') for s in cls.steps]
        cls.name = 'Write web pointer web.json (overview#470 P1)'

    def test_after_deploy_before_purge(self):
        i = self.names.index(self.name)
        self.assertGreater(i, self.names.index('Deploy to EdgeOne (staging, direct upload)'))
        self.assertGreater(i, self.names.index('Deploy to EdgeOne (production, kyg-ssr-spike)'))
        self.assertLess(i, self.names.index('Purge EdgeOne CDN cache'))

    def test_does_not_block_release(self):
        self.assertTrue(_step(self.wf['jobs']['build'], self.name).get('continue-on-error'))

    def test_uses_resolved_web_ref_and_cos_secrets(self):
        s = _step(self.wf['jobs']['build'], self.name)
        self.assertIn('needs.resolve.outputs.web_ref', s['env']['WEB_COMMIT_ID'])
        for k in ('COS_SECRET_ID', 'COS_SECRET_KEY', 'COS_BUCKET'):
            self.assertIn(k, s['env'])
        self.assertIn('write-web-pointer.mjs', s['run'])

    def test_purge_includes_web_json(self):
        self.assertIn("pfx + 'web.json'", self.raw)


@unittest.skipIf(yaml is None, 'PyYAML 未安装')
class SplitDataFlow(unittest.TestCase):
    """overview#470 P1：仓库变量 SPLIT_DATA_FLOW 打开后，代码流程不碰数据。变量不设（默认）时行为必须与拆出之前一致，
    所以这里钉的是「每个数据步骤都被开关挡得住」「两份正式站构建仍一致」「晋升与验收跟着开关走」。"""

    @classmethod
    def setUpClass(cls):
        with open(DEPLOY, encoding='utf-8') as f:
            cls.raw = f.read()
        cls.wf = yaml.safe_load(cls.raw)
        cls.build = cls.wf['jobs']['build']['steps']
        cls.names = [s.get('name', '') for s in cls.build]

    def _by_name(self, name, steps=None):
        hits = [x for x in (steps or self.build) if x.get('name') == name]
        self.assertEqual(len(hits), 1, name)
        return hits[0]

    def test_resolve_exposes_split_and_reads_variable(self):
        self.assertIn('split', self.wf['jobs']['resolve']['outputs'])
        r = [x for x in self.wf['jobs']['resolve']['steps'] if x.get('id') == 'r'][0]
        self.assertIn('vars.SPLIT_DATA_FLOW', r['env']['SPLIT_VAR'])
        # 三条路径（from_run 晋升、无 from_run 的晋升、测试站）都要输出 split
        self.assertEqual(r['run'].count('echo "split=$SPLIT" >> "$GITHUB_OUTPUT"'), 3)

    def test_split_step_sets_data_fast_before_any_data_step(self):
        n = 'Split data flow — skip all data steps (overview#470 P1)'
        st = self._by_name(n)
        self.assertIn('SPLIT_DATA', st['if'])
        self.assertIn('DATA_FAST=true', st['run'])
        i = self.names.index(n)
        for first_data in ('Data fast path — decide before cloning (overview#341)', 'Clone index data repos'):
            self.assertLess(i, self.names.index(first_data))

    def test_every_data_step_is_gated(self):
        # 这些步骤碰数据（克隆、打包、COS、sitemap 生成、指针）：必须被 DATA_FAST 或 SPLIT_DATA 挡得住
        data_steps = [
            'Data fast path — decide before cloning (overview#341)', 'Data fast path — restore item sitemaps',
            'Data fast path — write latest.json only', 'Clone index data repos', 'Build derived data (schema-v2)',
            'Bundle data for EdgeOne', 'Verify bundled data', 'Verify production entries bundled',
            'Verify no private text leaked into public data', 'Decide COS data sync (skip when data unchanged)',
            'Write latest.json only (data unchanged, skip COS data upload)',
            'Sync data to Tencent COS — current/ + h1 entry + h1 text, in parallel',
            'Record previous h1 root (W2-3)', 'Item sitemaps (W2-3)', 'Compute changed items (W2-3)',
        ]
        for n in data_steps:
            cond = str(self._by_name(n).get('if', ''))
            self.assertTrue('DATA_FAST' in cond or 'SPLIT_DATA' in cond or 'data_pre.outputs.skip' in cond, f'{n}: {cond!r}')

    def test_sitemap_proxy_flag_in_all_three_builds(self):
        for job, name in (('build', 'Build for EdgeOne (production, fullstack → kyg-ssr-spike)'),
                          ('prod-artifact', 'Build for EdgeOne (production, fullstack → kyg-ssr-spike)'),
                          ('build', 'Build for EdgeOne (staging, fullstack)')):
            env = _step(self.wf['jobs'][job], name)['env']
            self.assertIn('needs.resolve.outputs.split', env['NEXT_PUBLIC_SITEMAP_PROXY'], f'{job}/{name}')

    def test_staging_reads_prod_data_when_split(self):
        env = _step(self.wf['jobs']['build'], 'Build for EdgeOne (staging, fullstack)')['env']
        base = env['NEXT_PUBLIC_COS_BASE']
        self.assertIn("'https://data.kaiyuanguji.com/staging'", base)   # 不拆时仍是 staging 前缀
        self.assertIn('needs.resolve.outputs.split', base)

    def test_prod_artifact_skips_sitemap_generation_when_split(self):
        steps = self.wf['jobs']['prod-artifact']['steps']
        for n in ('Restore item sitemaps (www)', 'Clone, bundle and generate item sitemaps (cache miss)',
                  'Save item sitemaps cache (www)', 'Place item sitemaps',
                  'Restore git cache — book-index', 'Restore git cache — book-text',
                  'Save git cache — book-index', 'Save git cache — book-text'):
            self.assertIn("needs.resolve.outputs.split != 'true'", self._by_name(n, steps)['if'], n)

    def test_auto_promote_data_off_when_split_and_verify_follows(self):
        self.assertIn("needs.resolve.outputs.split != 'true'", self.wf['jobs']['auto-promote']['if'])
        self.assertIn('needs.resolve.outputs.split', self.wf['jobs']['verify']['with']['data_from_prod'])

    def test_check_artifact_script_gets_sitemap_mode(self):
        for job in ('build', 'prod-artifact'):
            st = _step(self.wf['jobs'][job], 'Verify production artifacts (fullstack)')
            self.assertIn('check-edgeone-artifact.sh', st['run'])
            self.assertIn("needs.resolve.outputs.split == 'true' && 'proxy' || 'static'", st['run'])

    def test_manifest_records_data_split(self):
        st = self._by_name('Write promote manifest (staging)')
        self.assertIn("'dataSplit'", st['run'])
        self.assertIn('needs.resolve.outputs.split', st['run'])

    def test_rehearse_split_input_only_affects_staging_dispatch(self):
        # 演练：手动测试站部署勾 rehearse_split，只对这一次按「已拆出」跑，不动仓库变量；晋升、push、定时不受影响
        triggers = self.wf.get('on') or self.wf.get(True)
        inp = triggers['workflow_dispatch']['inputs']['rehearse_split']
        self.assertEqual(inp['type'], 'boolean')
        self.assertIs(inp['default'], False)
        r = [x for x in self.wf['jobs']['resolve']['steps'] if x.get('id') == 'r'][0]
        self.assertIn('inputs.rehearse_split', r['env']['IN_REHEARSE_SPLIT'])
        self.assertIn('[ "$REQ" = staging ] && [ "$IN_REHEARSE_SPLIT" = true ]; then SPLIT=true', r['run'])
        # 自动晋升（push）和数据晋升（定时／repository_dispatch）都不会因为演练而被派
        self.assertIn("github.event_name == 'push'", self.wf['jobs']['auto-promote-code']['if'])
        self.assertNotIn('workflow_dispatch', self.wf['jobs']['auto-promote']['if'])

    def test_scheduled_check_skips_when_split(self):
        c = self.wf['jobs']['check']['steps'][0]
        self.assertIn('vars.SPLIT_DATA_FLOW', c['env']['SPLIT_DATA_FLOW'])
        self.assertIn('"$SPLIT_DATA_FLOW" = "true"', c['run'])


@unittest.skipIf(yaml is None, 'PyYAML 未安装')
class CodeOnlyPromote(unittest.TestCase):
    """自动晋升只推代码（promote=code），数据只在手动选 code+data／data 时才推。

    事故（2026-10-07，#284 合并后）：auto-promote-code 派的是 promote=code+data，把 schema-v2 数据也推向正式站（人工取消）。
    """

    @classmethod
    def setUpClass(cls):
        with open(DEPLOY, encoding='utf-8') as f:
            cls.raw = f.read()
        cls.wf = yaml.safe_load(cls.raw)
        cls.build = cls.wf['jobs']['build']
        cls.names = [s.get('name', '') for s in cls.build['steps']]

    def test_promote_input_has_code_and_defaults_to_it(self):
        triggers = self.wf.get('on') or self.wf.get(True)  # PyYAML 把裸 on 读成 True
        p = triggers['workflow_dispatch']['inputs']['promote']
        self.assertEqual(p['options'], ['code', 'code+data', 'data'])
        self.assertEqual(p['default'], 'code')

    def test_auto_promote_code_dispatches_code_only(self):
        job = self.wf['jobs']['auto-promote-code']
        run = '\n'.join(s.get('run', '') for s in job['steps'])
        self.assertIn('-f promote=code ', run)
        self.assertNotIn('promote=code+data', run)
        self.assertIn('-f from_run=', run)

    def test_only_scheduled_data_promote_carries_data(self):
        # 自动派的 workflow_dispatch 里，带数据的只有 auto-promote（promote=data，定时数据发布），代码那条不带
        self.assertEqual(self.raw.count('gh workflow run deploy.yml --ref main -f target=production -f promote=code+data'), 0)

    def test_resolve_requires_from_run_and_artifact_for_code(self):
        resolve = self.wf['jobs']['resolve']
        run = '\n'.join(s.get('run', '') for s in resolve['steps'])
        self.assertIn('promote=code 必须填 from_run', run)
        self.assertIn('promote=code 需要 run', run)  # 没产物就报错，不退回重新构建

    def test_code_only_step_leaves_data_alone(self):
        s = _step(self.build, 'Code-only promote — leave production data untouched')
        self.assertFalse(s.get('continue-on-error'))
        self.assertIn('CODE_ONLY', s['if'])
        self.assertIn('latest-only', s['run'])
        self.assertIn('DATA_FAST=true', s['run'])
        self.assertIn('promote', self.build['env']['CODE_ONLY'])
        self.assertIn("'code'", self.build['env']['CODE_ONLY'])

    def test_code_only_runs_before_every_data_step_and_blocks_decide(self):
        i = self.names.index('Code-only promote — leave production data untouched')
        for n in ('Restore git cache — book-index', 'Clone index data repos', 'Build derived data (schema-v2)',
                  'Bundle data for EdgeOne', 'Decide COS data sync (skip when data unchanged)',
                  'Sync data to Tencent COS — current/ + h1 entry + h1 text, in parallel'):
            self.assertGreater(self.names.index(n), i, n)
            self.assertIn('DATA_FAST', _step(self.build, n)['if'], n)
        self.assertIn('CODE_ONLY', _step(self.build, 'Data fast path — decide before cloning (overview#341)')['if'])

    def test_code_only_does_not_write_latest_json_when_split(self):
        # 数据流程拆出后 latest.json 只归数据流程写：只发代码这一步在开关打开时不能再改它
        s = _step(self.build, 'Code-only promote — leave production data untouched')
        self.assertIn("env.SPLIT_DATA != 'true'", s['if'])
        self.assertIn("env.SPLIT_DATA != 'true'", _step(self.build, 'Data fast path — decide before cloning (overview#341)')['if'])


if __name__ == '__main__':
    unittest.main()
