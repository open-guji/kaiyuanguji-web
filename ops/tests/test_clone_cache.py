"""克隆缓存（ops/clone-cached.sh，overview#470 P1）的检查。

1. deploy.yml 里内联的两份（build、prod-artifact）与正本逐字一致；
2. 用本机的假仓（file://）真跑一遍：没有缓存→全量浅拉；有缓存且上游多了新提交→只拉新增（对象数远小于全量）；
   同一个 commit→不再 fetch；缓存的 .git 超过上限→丢弃重拉；工作区文件每次都正确还原。
"""
import os
import re
import shutil
import subprocess
import tempfile
import unittest

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
SCRIPT = os.path.join(ROOT, 'ops', 'clone-cached.sh')
DEPLOY = os.path.join(ROOT, '.github', 'workflows', 'deploy.yml')
BEGIN = '# --- clone_cached:begin'
END = '# --- clone_cached:end'


def _block(text):
    a = text.index(BEGIN)
    b = text.index(END, a) + len(END)
    return text[a:b]


def sh(cmd, cwd=None, env=None):
    e = dict(os.environ, **(env or {}))
    r = subprocess.run(['bash', '-ec', cmd], cwd=cwd, env=e, capture_output=True, text=True)
    if r.returncode != 0:
        raise AssertionError(f'命令失败：{cmd}\n{r.stdout}\n{r.stderr}')
    return r.stdout + r.stderr


class InlineCopiesMatchCanonical(unittest.TestCase):
    def test_two_inline_copies_equal_script_block(self):
        with open(SCRIPT, encoding='utf-8') as f:
            canon = _block(f.read())
        with open(DEPLOY, encoding='utf-8') as f:
            deploy = f.read()
        self.assertEqual(deploy.count(BEGIN), 2, 'deploy.yml 应恰好内联两份（build、prod-artifact）')
        pos = 0
        for _ in range(2):
            a = deploy.index(BEGIN, pos)
            b = deploy.index(END, a) + len(END)
            inline = deploy[a:b]
            pos = b
            # 第一行前面带着 YAML 缩进，统一去掉
            lines = inline.split('\n')
            dedented = '\n'.join([lines[0]] + [l[10:] if l.startswith(' ' * 10) else l for l in lines[1:]])
            self.assertEqual(dedented, canon)


class CloneCachedBehaviour(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp(prefix='clone-cache-')
        cls.base = os.path.join(cls.tmp, 'remote')
        os.makedirs(cls.base)
        cls.work = os.path.join(cls.tmp, 'src')
        sh(f'git init -q -b main "{cls.work}"')
        sh('git config user.email t@t; git config user.name t; git config uploadpack.allowAnySHA1InWant true', cwd=cls.work)
        # 第一个提交：很多随机文件（模拟大仓）
        sh('mkdir -p Work && for i in $(seq 1 60); do head -c 20000 /dev/urandom | base64 > Work/f$i.md; done; git add -A; git commit -qm c1', cwd=cls.work)
        cls.c1 = sh('git rev-parse HEAD', cwd=cls.work).strip()
        # 第二个提交：只改一个文件
        sh('echo changed >> Work/f1.md; git add -A; git commit -qm c2', cwd=cls.work)
        cls.c2 = sh('git rev-parse HEAD', cwd=cls.work).strip()
        sh(f'git clone -q --bare "{cls.work}" "{cls.base}/demo.git"')
        sh('git config uploadpack.allowAnySHA1InWant true', cwd=f'{cls.base}/demo.git')

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def run_clone(self, dest, ref, env=None):
        e = {'GIT_BASE_URL': f'file://{self.base}'}
        e.update(env or {})
        return sh(f'source "{SCRIPT}"; clone_cached demo "{dest}" {ref}', env=e)

    def head(self, dest):
        return sh(f'git -C "{dest}" rev-parse HEAD').strip()

    def test_1_no_cache_full_shallow_then_incremental_then_same_commit(self):
        d1 = os.path.join(self.tmp, 'a')
        out = self.run_clone(d1, self.c1)
        self.assertIn('没有缓存：全量浅拉', out)
        self.assertEqual(self.head(d1), self.c1)
        self.assertTrue(os.path.isfile(os.path.join(d1, 'Work', 'f60.md')))

        # 只带 .git 去到「新机器」（模拟 actions/cache），工作区文件不带
        d2 = os.path.join(self.tmp, 'b')
        os.makedirs(d2)
        shutil.copytree(os.path.join(d1, '.git'), os.path.join(d2, '.git'))
        out = self.run_clone(d2, self.c2)
        self.assertIn('用缓存的 .git', out)
        self.assertEqual(self.head(d2), self.c2)
        self.assertTrue(os.path.isfile(os.path.join(d2, 'Work', 'f60.md')), '工作区文件应被还原')
        with open(os.path.join(d2, 'Work', 'f1.md')) as fh:
            self.assertTrue(fh.read().rstrip().endswith('changed'))
        self.assertEqual(sh(f'git -C "{d2}" status --porcelain').strip(), '', '还原后工作区应干净')

        # 同一个 commit：缓存里已有，不再 fetch
        out = self.run_clone(d2, self.c2)
        self.assertIn('缓存里已有这个 commit，不再 fetch', out)
        self.assertEqual(self.head(d2), self.c2)

    def test_2_incremental_fetch_transfers_little(self):
        d1 = os.path.join(self.tmp, 'c')
        self.run_clone(d1, self.c1)
        full_kb = int(sh(f'du -sk "{d1}/.git" | cut -f1').strip())
        d2 = os.path.join(self.tmp, 'd')
        os.makedirs(d2)
        shutil.copytree(os.path.join(d1, '.git'), os.path.join(d2, '.git'))
        self.run_clone(d2, self.c2)
        grown_kb = int(sh(f'du -sk "{d2}/.git" | cut -f1').strip()) - full_kb
        self.assertLess(grown_kb, full_kb * 0.2, f'增量应远小于全量（全量 {full_kb} KB，增长 {grown_kb} KB）')

    def test_3_oversized_cache_is_dropped(self):
        d1 = os.path.join(self.tmp, 'e')
        self.run_clone(d1, self.c1)
        out = self.run_clone(d1, self.c2, env={'GIT_CACHE_MAX_MB': '0'})
        self.assertIn('超过 0 MB 上限，丢弃后全量浅拉', out)
        self.assertEqual(self.head(d1), self.c2)

    def test_4_branch_ref_works_and_prints_timing(self):
        d = os.path.join(self.tmp, 'f')
        out = self.run_clone(d, 'main')
        self.assertEqual(self.head(d), self.c2)
        self.assertRegex(out, r'✔ demo 用时 \d+ 秒，\.git')
        self.assertIn('▶ 克隆 demo @ main', out)

    def test_5_bad_ref_fails(self):
        d = os.path.join(self.tmp, 'g')
        with self.assertRaises(AssertionError):
            self.run_clone(d, 'no-such-branch')

    def test_6_post_fetch_oversize_triggers_reset(self):
        # 增量前缓存不大、增量后超过上限：就地重来一次全量浅拉，存下去的不会是超大的
        work = os.path.join(self.tmp, 'big-src')
        sh(f'git init -q -b main "{work}"')
        sh('git config user.email t@t; git config user.name t; git config uploadpack.allowAnySHA1InWant true', cwd=work)
        sh('head -c 3000000 /dev/urandom > a.bin; git add -A; git commit -qm b1', cwd=work)
        b1 = sh('git rev-parse HEAD', cwd=work).strip()
        sh('head -c 3000000 /dev/urandom > b.bin; git add -A; git commit -qm b2', cwd=work)
        b2 = sh('git rev-parse HEAD', cwd=work).strip()
        sh(f'git clone -q --bare "{work}" "{self.base}/big.git"')
        sh('git config uploadpack.allowAnySHA1InWant true', cwd=f'{self.base}/big.git')
        env = {'GIT_BASE_URL': f'file://{self.base}', 'GIT_CACHE_MAX_MB': '5'}
        d1 = os.path.join(self.tmp, 'big1')
        sh(f'source "{SCRIPT}"; clone_cached big "{d1}" {b1}', env=env)
        d2 = os.path.join(self.tmp, 'big2')
        os.makedirs(d2)
        shutil.copytree(os.path.join(d1, '.git'), os.path.join(d2, '.git'))
        out = sh(f'source "{SCRIPT}"; clone_cached big "{d2}" {b2}', env=env)
        self.assertIn('用缓存的 .git', out)
        self.assertIn('重来一次全量浅拉', out)
        self.assertEqual(self.head(d2), b2)
        self.assertTrue(os.path.isfile(os.path.join(d2, 'b.bin')))

    def _fetch_calls(self, dest, ref, seed_from=None):
        """跑一次 clone_cached，返回这次所有 `git ... fetch ...` 调用的参数行（用 PATH 里的 git 包装器记录）"""
        shim_dir = os.path.join(self.tmp, 'shim')
        os.makedirs(shim_dir, exist_ok=True)
        log = os.path.join(self.tmp, f'fetch-{os.path.basename(dest)}.log')
        shim = os.path.join(shim_dir, 'git')
        with open(shim, 'w') as fh:
            fh.write(f'#!/bin/bash\nfor a in "$@"; do if [ "$a" = fetch ]; then echo "$@" >> "{log}"; break; fi; done\nexec "{shutil.which("git")}" "$@"\n')
        os.chmod(shim, 0o755)
        if seed_from:
            os.makedirs(dest)
            shutil.copytree(os.path.join(seed_from, '.git'), os.path.join(dest, '.git'))
        self.run_clone(dest, ref, env={'PATH': f'{shim_dir}:{os.environ["PATH"]}'})
        with open(log) as fh:
            return fh.read().splitlines()

    def test_7_cached_incremental_fetch_gives_negotiation_tip(self):
        # 回归（2026-10-07 实测）：--depth 1 的浅拉默认不拿本地已有对象和服务端对账，缓存再大也整棵树重传
        # （book-text：缓存是上一个 commit，仍收 218048 个对象、1.75 GiB）。有缓存时必须显式带 --negotiation-tip=HEAD。
        # 本机的 file:// 假仓复现不出 GitHub 上的整棵重传，所以这里钉的是调用本身，传输量的证据在 PR 描述里。
        d1 = os.path.join(self.tmp, 'n1')
        calls = self._fetch_calls(d1, self.c1)
        self.assertEqual(len(calls), 1, calls)
        self.assertNotIn('--negotiation-tip', calls[0], '没有缓存时没有可对账的东西，不该带')
        self.assertIn('--depth 1', calls[0])
        d2 = os.path.join(self.tmp, 'n2')
        calls = self._fetch_calls(d2, self.c2, seed_from=d1)
        self.assertEqual(len(calls), 1, calls)
        self.assertIn('--depth 1', calls[0])
        self.assertIn('--negotiation-tip=HEAD', calls[0])
        self.assertEqual(self.head(d2), self.c2)

    def test_8_oversize_reset_refetch_has_no_negotiation_tip(self):
        # 超限重来的那次全量浅拉是从空仓库开始的，没有 HEAD 可对账，带上反而会报错
        work = os.path.join(self.tmp, 'big-src2')
        sh(f'git init -q -b main "{work}"')
        sh('git config user.email t@t; git config user.name t; git config uploadpack.allowAnySHA1InWant true', cwd=work)
        sh('head -c 3000000 /dev/urandom > a.bin; git add -A; git commit -qm b1', cwd=work)
        b1 = sh('git rev-parse HEAD', cwd=work).strip()
        sh('head -c 3000000 /dev/urandom > b.bin; git add -A; git commit -qm b2', cwd=work)
        b2 = sh('git rev-parse HEAD', cwd=work).strip()
        sh(f'git clone -q --bare "{work}" "{self.base}/big2.git"')
        sh('git config uploadpack.allowAnySHA1InWant true', cwd=f'{self.base}/big2.git')
        env = {'GIT_BASE_URL': f'file://{self.base}', 'GIT_CACHE_MAX_MB': '5'}
        d1 = os.path.join(self.tmp, 'bg1')
        sh(f'source "{SCRIPT}"; clone_cached big2 "{d1}" {b1}', env=env)
        d2 = os.path.join(self.tmp, 'bg2')
        os.makedirs(d2)
        shutil.copytree(os.path.join(d1, '.git'), os.path.join(d2, '.git'))
        shim_dir = os.path.join(self.tmp, 'shim2')
        os.makedirs(shim_dir)
        log = os.path.join(self.tmp, 'fetch-bg2.log')
        with open(os.path.join(shim_dir, 'git'), 'w') as fh:
            fh.write(f'#!/bin/bash\nfor a in "$@"; do if [ "$a" = fetch ]; then echo "$@" >> "{log}"; break; fi; done\nexec "{shutil.which("git")}" "$@"\n')
        os.chmod(os.path.join(shim_dir, 'git'), 0o755)
        env['PATH'] = f'{shim_dir}:{os.environ["PATH"]}'
        out = sh(f'source "{SCRIPT}"; clone_cached big2 "{d2}" {b2}', env=env)
        self.assertIn('重来一次全量浅拉', out)
        with open(log) as fh:
            calls = fh.read().splitlines()
        self.assertEqual(len(calls), 2, calls)
        self.assertIn('--negotiation-tip=HEAD', calls[0])   # 先用缓存增量
        self.assertNotIn('--negotiation-tip', calls[1])     # 超限后从空仓库重来
        self.assertEqual(self.head(d2), b2)


if __name__ == '__main__':
    unittest.main()
