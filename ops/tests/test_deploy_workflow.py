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


if __name__ == '__main__':
    unittest.main()
