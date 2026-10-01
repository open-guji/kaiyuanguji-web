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


if __name__ == '__main__':
    unittest.main()
