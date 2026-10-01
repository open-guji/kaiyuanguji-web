"""ops/edgeone_usage_lib.py 单测（不联网）。

跑法（仓库根目录）：python3 -m unittest discover -s ops/tests -v
"""
import datetime as dt
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from edgeone_usage_lib import evaluate, render_md  # noqa: E402

TH = {"purgeUrlDaily": {"warnRatio": 0.5}, "functionRequestsMonth": {"limit": 1_000_000, "warnRatio": 0.7}}
NOW = dt.datetime(2026, 10, 11, 12, 0, tzinfo=dt.timezone(dt.timedelta(hours=8)))  # 本月已过 10.5 天，共 31 天


def l7(request, flux):
    detail = lambda xs: [{"Timestamp": 1760000000 + i * 86400, "Value": v} for i, v in enumerate(xs)]  # noqa: E731
    return {"Data": [{"TypeKey": "sum", "TypeValue": [
        {"MetricName": "l7Flow_request", "Detail": detail(request)},
        {"MetricName": "l7Flow_outFlux", "Detail": detail(flux)},
    ]}]}


class EvaluateTests(unittest.TestCase):
    def test_everything_unreadable_is_not_a_breach(self):
        r = evaluate({"quota": None, "l7_days": None, "billing": {}}, TH, NOW)
        self.assertEqual(r["breaches"], [])
        self.assertTrue(all(v == "取不到" for _, v, _ in r["rows"] if v == "取不到") and r["rows"])

    def test_purge_quota_over_warn_ratio(self):
        q = {"PurgeQuota": [{"Type": "purge_url", "Daily": 1000, "DailyAvailable": 400},
                            {"Type": "purge_all", "Daily": 5, "DailyAvailable": 0}]}
        r = evaluate({"quota": q, "l7_days": None, "billing": {}}, TH, NOW)
        self.assertEqual(len(r["breaches"]), 1)  # 只看 purge_url
        self.assertIn("600/1000", r["breaches"][0])

    def test_purge_quota_fine(self):
        q = {"PurgeQuota": [{"Type": "purge_url", "Daily": 1000, "DailyAvailable": 990}]}
        self.assertEqual(evaluate({"quota": q, "l7_days": None, "billing": {}}, TH, NOW)["breaches"], [])

    def test_function_requests_projected_over_limit(self):
        # 10.5 天用了 300k → 月底约 886k，> 70 万 → 告警（即使本月已用还没到）
        b = {"edgefunction_request": {"Data": [{"Time": "x", "Value": 150_000}, {"Time": "y", "Value": 150_000}]}}
        r = evaluate({"quota": None, "l7_days": None, "billing": b}, TH, NOW)
        self.assertEqual(len(r["breaches"]), 1)
        self.assertIn("300,000", r["breaches"][0])

    def test_function_requests_low(self):
        b = {"edgefunction_request": {"Data": [{"Time": "x", "Value": 10_000}]}}
        self.assertEqual(evaluate({"quota": None, "l7_days": None, "billing": b}, TH, NOW)["breaches"], [])

    def test_empty_billing_data_is_unknown_not_zero(self):
        r = evaluate({"quota": None, "l7_days": None, "billing": {"edgefunction_request": {"Data": []}}}, TH, NOW)
        self.assertIn(("本月边缘函数请求数（不含 Pages 云函数）", "取不到", "Pages 云函数调用以控制台为准，见月度人工清单"), r["rows"])

    def test_zero_function_requests_says_it_is_not_proof_of_no_usage(self):
        b = {"edgefunction_request": {"Data": [{"Time": "x", "Value": 0}]}}
        r = evaluate({"quota": None, "l7_days": None, "billing": b}, TH, NOW)
        note = [n for name, v, n in r["rows"] if name.startswith("本月边缘函数请求数")][0]
        self.assertIn("不代表没用量", note)
        self.assertEqual(r["breaches"], [])

    def test_l7_rows(self):
        r = evaluate({"quota": None, "l7_days": l7([100, 200], [1e9, 2e9]), "billing": {}}, TH, NOW)
        names = dict((n, v) for n, v, _ in r["rows"])
        self.assertEqual(names["近 7 天 L7 请求数"], "300")
        self.assertEqual(names["近 7 天 L7 响应流量"], "3.00 GB")

    def test_render_md_lists_breaches_and_errors(self):
        r = {"rows": [("项", "值", "")], "breaches": ["超了"]}
        md = render_md(r, ["清缓存额度：Boom"], NOW)
        self.assertIn("| 项 | 值 |  |", md)
        self.assertIn("### 超阈值", md)
        self.assertIn("- 超了", md)
        self.assertIn("清缓存额度：Boom", md)


if __name__ == "__main__":
    unittest.main()
