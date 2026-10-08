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
# CUT2 起 deploy.yml 在 release-log 上写的发布记录
NEW_MSG = "Released to kyg-ssr-spike from @ open-guji/kaiyuanguji-web@{} 🚀 (promote=code+data, run 42)"
# 新的在前：C 发了一次；B 发了两次（promote=data 重建同一版代码）；A 最早
LOG = "\n".join([f"{R4}\t{MSG.format(C)}", f"{R3}\t{MSG.format(B)}", f"{R2}\t{MSG.format(B)}",
                 f"{R1}\t{MSG.format(A)}", f"{'9' * 40}\tsome manual commit"])
POINTERS = {"production": {"commitId": "d1", "webCommitId": C}, "staging": {"commitId": "d1", "webCommitId": C}}


def plan(target="production", method="promote", web="", supports=True, has_version=True, log=LOG, pointers=POINTERS,
         skew=None, stage="start"):
    known = {A, B, C}
    return rp.make_plan(target, method, web, rp.parse_releases(log), pointers,
                        lambda c: next((k for k in known if k.startswith(c)), None),
                        lambda s: supports, lambda s: has_version, skew=skew, stage=stage)


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
        # 切站前 release-branch 回滚在 edgeone-release 写过的提交信息，仍须识别为一次发布
        line = f"{'5' * 40}\t{MSG.format(B)} (rollback to release 333333333333, run 1)"
        self.assertEqual(rp.parse_releases(line), [("5" * 40, B)])

    def test_release_log_message_counts_as_release(self):
        # 格式须与 deploy.yml「Record production release (release-log)」一致
        line = f"{'6' * 40}\t{NEW_MSG.format(C)}"
        self.assertEqual(rp.parse_releases(line), [("6" * 40, C)])

    def test_release_log_comes_before_legacy_history(self):
        # CUT2 后：release-log 上发过 D（最新），再往前接切站前 edgeone-release 的历史
        D, R5 = "d" * 40, "5" * 40
        rels = rp.merged_releases(f"{R5}\t{NEW_MSG.format(D)}", LOG)
        self.assertEqual(rels[0], (R5, D))
        self.assertEqual(rp.previous_source(rels, D), C)   # 跨过切站，上一版是切站前最后那次发布
        self.assertEqual(rp.previous_source(rels, C), B)

    def test_empty_release_log_falls_back_to_legacy(self):
        # CUT2 合入后、第一次正式发布前 release-log 还没建
        self.assertEqual(rp.merged_releases("", LOG), rp.parse_releases(LOG))


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

    def test_release_branch_is_retired(self):
        # CUT2：edgeone-release 发的是旧项目，www 已不在那里——明确报错并指向控制台止血
        for t in ("production", "staging"):
            p = plan(target=t, method="release-branch")
            self.assertTrue(any("已停用" in e and "kyg-ssr-spike" in e for e in p["errors"]), p["errors"])
            self.assertEqual(p["steps"], [])

    def test_promote_needs_t1_deploy_yml(self):
        p = plan(supports=False)
        self.assertTrue(any("T1 之前" in e and "控制台" in e for e in p["errors"]))
        self.assertFalse(any("method=release-branch" in e for e in p["errors"]))

    def test_warnings(self):
        self.assertTrue(any("404" in w for w in plan(has_version=False)["warnings"]))
        self.assertTrue(any("main HEAD" in w for w in plan()["warnings"]))
        self.assertTrue(any("当前版本" in w for w in plan(web=C)["warnings"]))

    def test_pre_e1_target_warns_on_staging(self):
        w = plan(target="staging", skew=lambda s: {"e1": False, "same_deploy": True})["warnings"]
        self.assertTrue(any("E1" in x and "503" in x for x in w))
        self.assertFalse(any("与 main 不同" in x for x in w))
        self.assertFalse(any("不受影响" in x for x in w))

    def test_pre_e1_target_is_error_on_production(self):
        # 正式站构建检出目标 commit、调用它自己的 ops/edgeone-fullstack-build.py：早于 E1 必失败
        for st in ("start", "promote", "check"):
            p = plan(stage=st, web=B, skew=lambda s: {"e1": False, "same_deploy": True})
            self.assertTrue(any("早于 E1" in e and rp.E1_MIN in e and "换绑回旧项目" in e for e in p["errors"]), (st, p["errors"]))
            self.assertFalse(any("E1" in w for w in p["warnings"]))

    def test_deploy_yml_differs_from_main_warns(self):
        w = plan(skew=lambda s: {"e1": True, "same_deploy": False})["warnings"]
        self.assertTrue(any("与 main 不同" in x for x in w))
        self.assertFalse(any("E1" in x for x in w))

    def test_no_skew_warning_when_pipeline_matches_or_unknown(self):
        for k in ({"e1": True, "same_deploy": True}, {"e1": True, "same_deploy": None}):
            w = plan(skew=lambda s, k=k: k)["warnings"]
            self.assertFalse(any("E1" in x or "与 main 不同" in x for x in w))

    def test_skew_warnings_are_not_errors(self):
        self.assertEqual(plan(skew=lambda s: {"e1": True, "same_deploy": False})["errors"], [])
        self.assertEqual(plan(target="staging", skew=lambda s: {"e1": False, "same_deploy": False})["errors"], [])

    def test_later_stages_need_explicit_commit(self):
        # promote 完 release-log 多一版，「上一次正式发布」就变了——后续段不许靠默认
        for st in ("promote", "check"):
            self.assertTrue(any("必须显式给 web_commit" in e for e in plan(stage=st)["errors"]))
            self.assertEqual(plan(stage=st, web=B)["errors"], [])

    def test_promote_stage_only_for_production(self):
        self.assertTrue(any("只用于 target=production" in e for e in plan(target="staging", stage="promote", web=B)["errors"]))
        self.assertEqual(plan(target="staging", stage="check", web=B)["errors"], [])

    def test_stage_steps_never_wait_on_deploy(self):
        # 自托管单 runner：任何一段都只发起、不等 deploy.yml（等就死锁）
        for st, t in (("start", "production"), ("start", "staging"), ("promote", "production")):
            steps = plan(target=t, stage=st, web=B)["steps"]
            self.assertTrue(any("不等" in x for x in steps), (st, t, steps))
        self.assertIn("stage=promote", " ".join(plan(stage="start")["steps"]))
        self.assertIn("stage=check", " ".join(plan(target="staging", stage="start")["steps"]))

    def test_current_version_warning_only_on_start(self):
        self.assertFalse(any("当前版本" in w for w in plan(web=C, stage="check")["warnings"]))

    def test_hosted_runner_target_warns_first(self):
        w = plan(skew=lambda s: {"e1": True, "same_deploy": False, "self_hosted": False, "main_self_hosted": True})["warnings"]
        self.assertIn("托管 runner", w[0])
        self.assertIn("控制台", w[0])
        w2 = plan(skew=lambda s: {"e1": True, "same_deploy": True, "self_hosted": True})["warnings"]
        self.assertFalse(any("托管 runner" in x for x in w2))
        # main 也跑托管（仓库公开期间）：目标跑托管不算问题
        w3 = plan(skew=lambda s: {"e1": True, "same_deploy": True, "self_hosted": False, "main_self_hosted": False})["warnings"]
        self.assertFalse(any("托管 runner" in x for x in w3))

    def test_empty_history_is_error_not_crash(self):
        p = plan(log="")
        self.assertTrue(p["errors"])
        self.assertIn("回滚计划", rp.summary_md(p, True))


if __name__ == "__main__":
    unittest.main()


class CodePointerReaders(unittest.TestCase):
    """overview#470 P1 方案 A：latest.json 标了 codePointer 以 web.json 为准，没标仍以 latest.json.webCommitId 为准。"""

    def _plan(self, pointers, web_pointers, target="production"):
        known = {A, B, C}
        return rp.make_plan(target, "promote", A, [], pointers, lambda c: next((k for k in known if k.startswith(c)), None),
                            lambda s: True, lambda s: True, web_pointers=web_pointers)

    def test_unmarked_uses_latest_and_only_mentions_web(self):
        p = self._plan({"production": {"commitId": "d", "webCommitId": C}, "staging": {"commitId": "d", "webCommitId": C}},
                       {"production": {"webCommitId": B}, "staging": {"webCommitId": B}})
        self.assertEqual(p["current_prod_web"], C)
        self.assertEqual(p["code_pointer"]["production"]["source"], "latest.json")
        self.assertTrue(p["code_pointer"]["production"]["mismatch"])
        self.assertTrue(any("以 latest.json 为准" in w for w in p["warnings"]))     # 不一致写出来

    def test_marked_uses_web_json_and_says_so(self):
        marked = {"commitId": "d", "webCommitId": C, "codePointer": "web.json"}
        p = self._plan({"production": marked, "staging": dict(marked)}, {"production": {"webCommitId": B}, "staging": {"webCommitId": B}})
        self.assertEqual(p["current_prod_web"], B)
        self.assertEqual(p["current_web"], B)
        self.assertEqual(p["code_pointer"]["production"]["source"], "web.json")
        self.assertTrue(any("以 web.json 为准" in w and B[:12] in w and C[:12] in w for w in p["warnings"]))
        self.assertIn("codePointer", rp.summary_md(p, True).replace("`", "") + "codePointer")  # 摘要能渲染

    def test_marked_but_web_missing_falls_back_with_warning(self):
        marked = {"commitId": "d", "webCommitId": C, "codePointer": "web.json"}
        p = self._plan({"production": marked, "staging": dict(marked)}, {})
        self.assertEqual(p["current_prod_web"], C)
        self.assertIn("web.json 缺失，退回", p["code_pointer"]["production"]["source"])
        self.assertTrue(any("读不到或不合法" in w for w in p["warnings"]))

    def test_staging_target_reads_staging_pointers(self):
        p = self._plan({"production": {"commitId": "d", "webCommitId": C},
                        "staging": {"commitId": "d", "webCommitId": C, "codePointer": "web.json"}},
                       {"production": {"webCommitId": A}, "staging": {"webCommitId": B}}, target="staging")
        self.assertEqual(p["current_web"], B)            # 测试站标了：用 staging/web.json
        self.assertEqual(p["current_prod_web"], C)       # 正式站没标：仍用 latest.json


class RollbackCheckReader(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        sp = importlib.util.spec_from_file_location("rc", HERE.parent / "rollback-check.py")
        cls.rc = importlib.util.module_from_spec(sp)
        sp.loader.exec_module(cls.rc)

    def _check(self, latest, web, want):
        docs = {self.rc.POINTERS["staging"]: latest, self.rc.WEB_POINTERS["staging"]: web}
        self.rc.get_json = lambda url: (200, docs[url]) if docs.get(url) is not None else (404, None)
        return self.rc.check_once("staging", want, True, False)

    def test_unmarked_judged_by_latest_not_web(self):
        self.assertEqual(self._check({"webCommitId": A}, {"webCommitId": B}, A), [])           # web 落后不影响
        self.assertTrue(self._check({"webCommitId": A}, {"webCommitId": B}, B))                 # web 对而 latest 不对 → 仍不通过

    def test_marked_judged_by_web_json(self):
        marked = {"webCommitId": A, "codePointer": "web.json"}
        self.assertEqual(self._check(marked, {"webCommitId": B}, B), [])
        self.assertTrue(self._check(marked, {"webCommitId": B}, A))                              # latest 的旧值不能让它通过

    def test_marked_web_missing_falls_back_to_latest(self):
        marked = {"webCommitId": A, "codePointer": "web.json"}
        self.assertEqual(self._check(marked, None, A), [])
        self.assertTrue(self._check(marked, None, B))
