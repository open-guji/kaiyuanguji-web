"""data.yml 的一致性检查（overview#470 P1）。

第一期的数据流程**只做检查**：不能有任何写 COS／上线的东西，不能带 secrets；与 deploy.yml 并行跑，
所以并发组、触发、步骤顺序、「只报告」的步骤都钉住，免得以后改着改着悄悄变成会上传的流程。
"""
import os
import re
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

    def test_no_secrets_and_no_cos(self):
        # 注释里可以提 secrets／COS（说明文字），可执行内容里不能有
        code = '\n'.join(l for l in self.raw.splitlines() if not l.lstrip().startswith('#'))
        self.assertNotIn('secrets.', code)
        self.assertNotRegex(code, r'COS_(SECRET|BUCKET)')
        self.assertNotIn('sync-to-cos', code)
        self.assertNotIn('write-web-pointer', code)

    def test_read_only_permissions(self):
        self.assertEqual(self.wf['permissions'], {'contents': 'read'})

    def test_concurrency_publish_data_not_cancelling(self):
        c = self.wf['concurrency']
        self.assertEqual(c['group'], 'publish-data')
        self.assertFalse(c['cancel-in-progress'])

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


if __name__ == '__main__':
    unittest.main()
