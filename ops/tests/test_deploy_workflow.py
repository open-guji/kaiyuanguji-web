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


if __name__ == '__main__':
    unittest.main()


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
