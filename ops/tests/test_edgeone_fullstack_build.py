"""ops/edgeone-fullstack-build.py 单测（不联网、不真构建）。

跑法（仓库根目录）：python3 -m unittest discover -s ops/tests -v
"""
import importlib.util
import io
import json
import os
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("efb", HERE.parent / "edgeone-fullstack-build.py")
efb = importlib.util.module_from_spec(spec)
spec.loader.exec_module(efb)

SECRET = "jwt_secret_ABCDEFGHIJKLMNOP"
TOKEN = "api_token_ZYXWVUTSRQPONMLK"
REVAL = "revalidate_secret_0123456789abcdef"


def write(root, rel, text):
    p = Path(root, rel)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(text, encoding="utf-8")


def edge_index(env):
    return "const x = (" + "{request, env: " + json.dumps(env, ensure_ascii=False, separators=(",", ":")) + "});"


class SelectVars(unittest.TestCase):
    def test_filters_by_environment_and_key(self):
        got = efb.select_vars([
            {"Key": "A", "Value": "1"},                              # 不分环境
            {"Key": "B", "Value": "2", "Env": ["production"]},
            {"Key": "C", "Value": "3", "Env": ["preview"]},          # 只预览
            {"Key": "bad-key", "Value": "4"},                        # 非法标识符
            {"Key": "TENCENT_SECRET_KEY", "Value": "5"},             # 永不带
            {"Key": "EDGEONE_API_TOKEN", "Value": "6"},
            {"Key": "D", "Value": None},
        ])
        self.assertEqual(got, {"A": "1", "B": "2"})

    def test_env_case_insensitive(self):
        # 接口实际返回首字母大写
        got = efb.select_vars([
            {"Key": "A", "Value": "1", "Env": ["Production", "Preview"]},
            {"Key": "B", "Value": "2", "Env": ["Preview"]},
        ])
        self.assertEqual(got, {"A": "1"})

    def test_preview(self):
        got = efb.select_vars([{"Key": "C", "Value": "3", "Env": ["preview"]}], "preview")
        self.assertEqual(got, {"C": "3"})


class ChildEnv(unittest.TestCase):
    def test_allowlist_and_project_vars(self):
        parent = {
            "PATH": "/bin", "HOME": "/root", "NEXT_PUBLIC_SITE_ENV": "staging",
            "KYG_RENDER_MODE": "fullstack", "SITEMAP_SITE": "x",
            "EDGEONE_API_TOKEN": TOKEN, "GITHUB_TOKEN": "g", "COS_SECRET_KEY": "c", "RANDOM": "r",
        }
        env, clash = efb.child_env(parent, {"AUTH_JWT_SECRET": SECRET, "NEXT_PUBLIC_SITE_ENV": "console"})
        self.assertEqual(env["AUTH_JWT_SECRET"], SECRET)
        self.assertEqual(env["NEXT_PUBLIC_SITE_ENV"], "staging")  # CI 构建配置优先
        self.assertEqual(clash, ["NEXT_PUBLIC_SITE_ENV"])
        for k in ("EDGEONE_API_TOKEN", "GITHUB_TOKEN", "COS_SECRET_KEY", "RANDOM"):
            self.assertNotIn(k, env)
        for k in ("PATH", "HOME", "KYG_RENDER_MODE", "SITEMAP_SITE"):
            self.assertIn(k, env)

    def test_kyg_exact_names_only(self):
        # SEC overview#134 第 5 条：KYG_* 不按前缀放行，只放点名的
        parent = {"KYG_RENDER_MODE": "fullstack", "KYG_REVALIDATE_SECRET": REVAL, "KYG_DEPLOY_TARGET": "production",
                  "KYG_DATA_ROOT": "/tmp/d", "KYG_SOME_FUTURE_SECRET": "s3cr3t-value-xyz"}
        env, _ = efb.child_env(parent, {})
        # KYG_DEPLOY_TARGET：CUT2 正式站全栈构建要把 /api/version 的 target 写成 production，不放行就会记成 ssr-test
        self.assertEqual(sorted(env), ["KYG_DEPLOY_TARGET", "KYG_RENDER_MODE", "KYG_REVALIDATE_SECRET"])

    def test_extra_pass(self):
        env, _ = efb.child_env({"FOO": "1"}, {}, {"FOO"})
        self.assertEqual(env, {"FOO": "1"})


class ScanBundle(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = self.tmp.name
        self.pv = {"AUTH_JWT_SECRET": SECRET, "OAUTH_CLIENTS": '{"c":{"s":"古籍 x"}}', "FLAG": "1"}
        write(self.root, "edge-functions/index.js", edge_index(self.pv))
        write(self.root, "assets/index.html", "<html>ok</html>")
        write(self.root, "cloud-functions/ssr-node/server.js", "module.exports = 1")

    def tearDown(self):
        self.tmp.cleanup()

    def scan(self, forbidden=None):
        return efb.scan_bundle(self.root, self.pv, forbidden or {})

    def test_clean(self):
        self.assertEqual(self.scan({"EDGEONE_API_TOKEN": TOKEN}), [])

    def test_dotenv_file_anywhere(self):
        write(self.root, "cloud-functions/ssr-node/app/.env", "X=1")
        write(self.root, "assets/.env.production", "X=1")
        probs = self.scan()
        self.assertEqual(len(probs), 2)
        self.assertTrue(all(".env" in p for p in probs))

    def test_project_value_outside_edge(self):
        write(self.root, "assets/_next/static/chunks/a.js", f'var s="{SECRET}"')
        probs = self.scan()
        self.assertEqual(len(probs), 1)
        self.assertIn("AUTH_JWT_SECRET", probs[0])
        self.assertIn("assets/_next/static/chunks/a.js", probs[0])
        self.assertNotIn(SECRET, probs[0])  # 报错不含值

    def test_project_value_json_escaped_outside_edge(self):
        escaped = json.dumps(self.pv["OAUTH_CLIENTS"], ensure_ascii=False)
        write(self.root, "cloud-functions/ssr-node/cfg.json", '{"v":' + escaped + '}')
        probs = self.scan()
        self.assertEqual(len(probs), 1)
        self.assertIn("OAUTH_CLIENTS", probs[0])

    def test_short_values_not_scanned(self):
        write(self.root, "assets/a.txt", "1 1 1")
        self.assertEqual(self.scan(), [])

    def test_forbidden_anywhere_including_edge(self):
        write(self.root, "edge-functions/index.js", edge_index({**self.pv, "EDGEONE_API_TOKEN": TOKEN}))
        probs = self.scan({"EDGEONE_API_TOKEN": TOKEN})
        self.assertEqual(len(probs), 1)
        self.assertIn("EDGEONE_API_TOKEN", probs[0])
        self.assertNotIn(TOKEN, probs[0])

    def test_missing_from_edge(self):
        write(self.root, "edge-functions/index.js", edge_index({"FLAG": "1"}))
        probs = self.scan()
        self.assertEqual(sorted(probs), sorted([
            "项目变量 AUTH_JWT_SECRET 没有进 edge-functions/index.js 的 context.env",
            "项目变量 OAUTH_CLIENTS 没有进 edge-functions/index.js 的 context.env",
        ]))

    def test_assets_forbidden_in_assets(self):
        write(self.root, "assets/_next/static/chunks/app.js", f'var k="{REVAL}"')
        probs = efb.scan_bundle(self.root, self.pv, {}, {"KYG_REVALIDATE_SECRET": REVAL})
        self.assertEqual(len(probs), 1)
        self.assertIn("KYG_REVALIDATE_SECRET", probs[0])
        self.assertIn(f"sha {efb.tag(REVAL)}", probs[0])
        self.assertIn("assets/_next/static/chunks/app.js", probs[0])
        self.assertNotIn(REVAL, probs[0])  # 报错不含值

    def test_assets_forbidden_json_escaped(self):
        write(self.root, "assets/data.json", json.dumps({"k": REVAL}))
        probs = efb.scan_bundle(self.root, self.pv, {}, {"KYG_REVALIDATE_SECRET": REVAL})
        self.assertEqual(len(probs), 1)

    def test_assets_forbidden_allowed_server_side(self):
        # 服务端路由（cloud-functions）与边缘函数里有它是预期的
        write(self.root, "cloud-functions/ssr-node/app/internal/revalidate/route.js", f'const s="{REVAL}"')
        write(self.root, "edge-functions/index.js", edge_index({**self.pv, "KYG_REVALIDATE_SECRET": REVAL}))
        self.assertEqual(efb.scan_bundle(self.root, self.pv, {}, {"KYG_REVALIDATE_SECRET": REVAL}), [])

    def test_no_edge_index(self):
        os.remove(Path(self.root, "edge-functions/index.js"))
        probs = self.scan()
        self.assertTrue(any("没有 edge-functions/index.js" in p for p in probs))


class MainEndToEnd(unittest.TestCase):
    """用一个假「构建命令」走完 main：子进程看不到 CI 机密、产物校验生效、输出不含值。"""

    def run_main(self, build_py, extra_env=None, argv_extra=()):
        with tempfile.TemporaryDirectory() as d:
            pv = Path(d, "pv.json")
            pv.write_text(json.dumps({"AUTH_JWT_SECRET": SECRET}), encoding="utf-8")
            script = Path(d, "build.py")
            script.write_text(build_py, encoding="utf-8")
            out = Path(d, ".edgeone")
            old = dict(os.environ)
            os.environ.update({"EDGEONE_API_TOKEN": TOKEN, **(extra_env or {})})
            buf = io.StringIO()
            code = 0
            try:
                with redirect_stdout(buf):
                    efb.main(["--env-json", str(pv), "--forbid-env", "EDGEONE_API_TOKEN",
                              "--out", str(out), "--retries", "1", *argv_extra, "--",
                              sys.executable, str(script), str(out)])
            except SystemExit as e:
                code = e.code
            finally:
                os.environ.clear()
                os.environ.update(old)
            return code, buf.getvalue()

    # 假构建：像 makers build 一样把自己的整份环境写进 edge-functions/index.js
    FAKE_BUILD = (
        "import json, os, sys\n"
        "root = sys.argv[1]\n"
        "os.makedirs(os.path.join(root, 'edge-functions'), exist_ok=True)\n"
        "open(os.path.join(root, 'edge-functions', 'index.js'), 'w').write("
        "'f({env: ' + json.dumps(dict(os.environ), ensure_ascii=False, separators=(',', ':')) + '})')\n"
    )

    def test_ok(self):
        code, out = self.run_main(self.FAKE_BUILD)
        self.assertIn(code, (0, None))
        self.assertIn("✓ 产物无 .env", out)
        # 在 Actions 里脚本会先输出 ::add-mask::<值> 让 runner 遮蔽它（该行本身不显示），不算泄露
        visible = "\n".join(l for l in out.splitlines() if not l.startswith("::add-mask::"))
        self.assertNotIn(SECRET, visible)
        self.assertNotIn(TOKEN, visible)

    def test_leak_is_caught_when_token_passed(self):
        leak = self.FAKE_BUILD + (
            "open(os.path.join(root, 'leak.txt'), 'w').write(" + repr(TOKEN) + ")\n")
        code, out = self.run_main(leak)
        self.assertEqual(code, 1)
        self.assertIn("EDGEONE_API_TOKEN", out)
        self.assertNotIn(TOKEN, out)

    def test_revalidate_secret_in_assets_is_caught(self):
        leak = self.FAKE_BUILD + (
            "os.makedirs(os.path.join(root, 'assets'), exist_ok=True)\n"
            "open(os.path.join(root, 'assets', 'chunk.js'), 'w').write(os.environ.get('KYG_REVALIDATE_SECRET', ''))\n")
        code, out = self.run_main(leak, extra_env={"KYG_REVALIDATE_SECRET": REVAL})
        self.assertEqual(code, 1)
        self.assertIn("KYG_REVALIDATE_SECRET", out)
        self.assertIn("assets", out)
        self.assertNotIn(REVAL, out)

    def test_revalidate_secret_reaches_build_but_not_assets(self):
        # 构建子进程拿得到（服务端路由要用），产物 assets 里没有 → 通过
        code, out = self.run_main(self.FAKE_BUILD, extra_env={"KYG_REVALIDATE_SECRET": REVAL, "KYG_DATA_ROOT": "/tmp/x"})
        self.assertIn(code, (0, None))
        self.assertIn("1 个服务端构建变量未出现在 assets/", out)
        self.assertNotIn(REVAL, out)

    def test_require_missing(self):
        code, out = self.run_main(self.FAKE_BUILD, argv_extra=["--require", "ERROR_VIEW_TOKEN"])
        self.assertIn("ERROR_VIEW_TOKEN", str(code))

    def test_require_present(self):
        code, _ = self.run_main(self.FAKE_BUILD, argv_extra=["--require", "AUTH_JWT_SECRET"])
        self.assertIn(code, (0, None))

    def test_build_failure(self):
        code, _ = self.run_main("import sys; sys.exit(3)")
        self.assertIn("构建重试 1 次仍失败", str(code))


if __name__ == "__main__":
    unittest.main()
