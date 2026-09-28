"""ops/rollback-plan.py 单测（不联网、不碰 git）。

跑法（仓库根目录）：python3 -m unittest discover -s ops/tests -v
"""
import importlib.util
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("rp", HERE.parent / "rollback-plan.py")
rp = importlib.util.module_from_spec(spec)
spec.loader.exec_module(rp)

A, B, C = "a" * 40, "b" * 40, "c" * 40
R1, R2, R3, R4 = "1" * 40, "2" * 40, "3" * 40, "4" * 40
MSG = "Deploying to edgeone-release from @ open-guji/kaiyuanguji-web@{} 🚀"
# 新的在前：C 发了一次；B 发了两次（promote=data 重建同一版代码）；A 最早
LOG = "\n".join([f"{R4}\t{MSG.format(C)}", f"{R3}\t{MSG.format(B)}", f"{R2}\t{MSG.format(B)}",
                 f"{R1}\t{MSG.format(A)}", f"{'9' * 40}\tsome manual commit"])
POINTERS = {"production": {"commitId": "d1", "webCommitId": C}, "staging": {"commitId": "d1", "webCommitId": C}}


def plan(target="production", method="promote", web="", supports=True, has_version=True, log=LOG, pointers=POINTERS):
    known = {A, B, C}
    return rp.make_plan(target, method, web, rp.parse_releases(log), pointers,
                        lambda c: next((k for k in known if k.startswith(c)), None),
                        lambda s: supports, lambda s: has_version)


class Releases(unittest.TestCase):
    def test_parse_skips_non_release_commits(self):
        self.assertEqual(rp.parse_releases(LOG), [(R4, C), (R3, B), (R2, B), (R1, A)])

    def test_previous_is_first_distinct_older_source(self):
        rels = rp.parse_releases(LOG)
        self.assertEqual(rp.previous_source(rels, C), B)
        self.assertEqual(rp.previous_source(rels, B), A)   # 跳过 B 的重复发布
        self.assertIsNone(rp.previous_source(rels, A))
        self.assertEqual(rp.previous_source(rels, ""), B)

    def test_release_for_takes_newest_build_of_that_source(self):
        self.assertEqual(rp.release_for(rp.parse_releases(LOG), B), R3)

    def test_rollback_commit_message_counts_as_release(self):
        # rollback.yml release-branch 路写的提交信息必须仍被识别，否则下次「上一版」会算错
        line = f"{'5' * 40}\t{MSG.format(B)} (rollback to release 333333333333, run 1)"
        self.assertEqual(rp.parse_releases(line), [("5" * 40, B)])


class Plan(unittest.TestCase):
    def test_default_is_previous_production_release(self):
        p = plan()
        self.assertEqual(p["errors"], [])
        self.assertEqual((p["web_commit"], p["release_sha"], p["chosen_by"]), (B, R3, "默认：上一次正式发布"))

    def test_explicit_short_sha_is_resolved(self):
        p = plan(web=A[:12])
        self.assertEqual((p["web_commit"], p["release_sha"]), (A, R1))

    def test_unknown_or_bad_commit_is_error(self):
        self.assertTrue(plan(web="f" * 12)["errors"])
        self.assertTrue(plan(web="not-a-sha; rm -rf /")["errors"])

    def test_release_branch_only_for_production_and_only_released_commits(self):
        self.assertTrue(plan(target="staging", method="release-branch")["errors"])
        known_unreleased = rp.make_plan("production", "release-branch", "", [], POINTERS, lambda c: None,
                                        lambda s: True, lambda s: True)
        self.assertTrue(known_unreleased["errors"])

    def test_promote_needs_t1_deploy_yml(self):
        p = plan(supports=False)
        self.assertTrue(any("release-branch" in e for e in p["errors"]))

    def test_warnings(self):
        self.assertTrue(any("404" in w for w in plan(has_version=False)["warnings"]))
        self.assertTrue(any("main HEAD" in w for w in plan()["warnings"]))
        self.assertTrue(any("AUTO_PROMOTE_DATA" in w for w in plan(method="release-branch")["warnings"]))
        self.assertTrue(any("当前版本" in w for w in plan(web=C)["warnings"]))

    def test_empty_history_is_error_not_crash(self):
        p = plan(log="")
        self.assertTrue(p["errors"])
        self.assertIn("回滚计划", rp.summary_md(p, True))


if __name__ == "__main__":
    unittest.main()
