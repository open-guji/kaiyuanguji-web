"""ops/purge-urls.py：只允许清数据域名下的地址（overview#470 P1）。
用 --dry-run 走命令行，不联网、不需要密钥。
"""
import importlib.util
import os
import subprocess
import sys
import unittest

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
SCRIPT = os.path.join(ROOT, 'ops', 'purge-urls.py')
sys.path.insert(0, os.path.join(ROOT, 'ops'))
import hosts  # noqa: E402

D = hosts.DATA_ORIGIN + '/'
L = hosts.LEGACY_DATA_ORIGIN + '/'

spec = importlib.util.spec_from_file_location('purge_urls', SCRIPT)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)


def cli(*args, env=None):
    e = {k: v for k, v in os.environ.items() if not k.startswith('TENCENT') and k not in ('EDGEONE_ZONE_ID', 'EDGEONE_DATA_ZONE_ID')}
    e.update(env or {})
    return subprocess.run([sys.executable, '-I', SCRIPT, *args], capture_output=True, text=True, env=e)


class PurgeUrls(unittest.TestCase):
    def test_accepts_data_host_urls(self):
        self.assertEqual(mod.check_urls([D + 'latest.json', D + 'staging/h1/manifest-root.json']), [])

    def test_accepts_legacy_data_host_urls(self):
        self.assertEqual(mod.check_urls([L + 'latest.json']), [])

    def test_rejects_other_hosts_pages_and_whole_site(self):
        for o in (D, L):
            host = o[len('https://'):-1]
            for bad in ('https://www.kaiyuanguji.com/item/abc', 'https://kaiyuanguji.com/', f'http://{host}/latest.json',
                        f'https://{host}.evil.com/x', f'https://{host}', f'{host}/latest.json'):
                self.assertTrue(mod.check_urls([bad]), bad)

    def test_plan_mirrors_each_path_to_both_data_hosts(self):
        groups = mod.plan([D + 'latest.json', L + 'h1/manifest-root.json', L + 'latest.json'])
        by_env = {env: (required, urls) for env, required, urls in groups}
        self.assertEqual(by_env['EDGEONE_ZONE_ID'], (True, [L + 'latest.json', L + 'h1/manifest-root.json']))
        if D != L:
            self.assertEqual(by_env['EDGEONE_DATA_ZONE_ID'], (False, [D + 'latest.json', D + 'h1/manifest-root.json']))

    def test_rejects_wildcards_whitespace_empty_and_too_many(self):
        self.assertTrue(mod.check_urls([D + '*']))
        self.assertTrue(mod.check_urls([D + 'a b']))
        self.assertTrue(mod.check_urls([]))
        self.assertTrue(mod.check_urls([D + f'{i}.json' for i in range(mod.MAX_URLS + 1)]))

    def test_cli_dry_run_lists_urls_without_credentials(self):
        r = cli('--dry-run', D + 'latest.json', D + 'sitemaps/sitemap-index.xml')
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn(D + 'latest.json', r.stdout)
        self.assertIn(D + 'sitemaps/sitemap-index.xml', r.stdout)

    def test_cli_rejects_bad_url_even_in_dry_run(self):
        r = cli('--dry-run', 'https://www.kaiyuanguji.com/')
        self.assertEqual(r.returncode, 1)
        self.assertIn('只允许', r.stderr)

    def test_cli_without_urls_is_usage_error_and_without_credentials_fails(self):
        self.assertEqual(cli().returncode, 2)
        r = cli(D + 'latest.json')           # 真清：没有密钥就失败，不去联网
        self.assertEqual(r.returncode, 1)
        self.assertIn('缺环境变量', r.stderr)


if __name__ == '__main__':
    unittest.main()
