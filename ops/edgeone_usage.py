#!/usr/bin/env python3
"""EdgeOne 用量检查（overview#280 M3）：只读，读不到的项目写「取不到」而不是失败。

读三类数据（腾讯云 TEO API，同 edgeone-purge-urls.py 的凭据）：
  1. 清缓存额度（DescribeContentQuota）：每日剩余 vs 上限
  2. 近 7 天 L7 请求数与响应流量（DescribeTimingL7AnalysisData，按天）
  3. 本月计费用量（DescribeBillingData）：边缘函数请求数 edgefunction_request、内容加速流量 acc_flux
     注意：Pages 的「云函数调用」是否计在 edgefunction_request 里，要看首次运行的实际数值，
     对不上就以控制台为准（见 overview 项目进展/古籍索引网站/进度/运维/EdgeOne用量-月度人工检查.md）。

输出：Markdown 到 stdout 与 $OUT_MD；超阈值项另写到 $OUT_BREACH（每行一条，空文件＝没有超标）。
阈值来自 ops/edgeone-usage-thresholds.json。判定逻辑在 edgeone_usage_lib.py（纯函数，有单测）。
"""
import datetime as dt
import json
import os
import sys

from edgeone_usage_lib import evaluate, render_md

HERE = os.path.dirname(os.path.abspath(__file__))


def _call(label, fn):
    """取数失败（权限、接口不支持）不让整个检查失败：记下原因，后续按「取不到」展示。"""
    try:
        return fn(), None
    except Exception as e:  # noqa: BLE001 — SDK 异常类型很多，统一兜住
        return None, f"{label}：{type(e).__name__}: {str(e)[:200]}"


def main():
    from tencentcloud.common import credential
    from tencentcloud.teo.v20220901 import models, teo_client

    zone = os.environ["EDGEONE_ZONE_ID"]
    cred = credential.Credential(os.environ["TENCENT_SECRET_ID"], os.environ["TENCENT_SECRET_KEY"])
    client = teo_client.TeoClient(cred, "")
    now = dt.datetime.now(dt.timezone(dt.timedelta(hours=8))).replace(microsecond=0)
    fmt = lambda t: t.isoformat()  # noqa: E731 — TEO 要 ISO8601 带时区

    errors = []
    data = {"quota": None, "l7_days": None, "billing": {}}

    def quota():
        r = models.DescribeContentQuotaRequest()
        r.ZoneId = zone
        return json.loads(client.DescribeContentQuota(r).to_json_string())

    data["quota"], err = _call("清缓存额度", quota)
    errors.append(err)

    def l7():
        r = models.DescribeTimingL7AnalysisDataRequest()
        r.StartTime = fmt(now - dt.timedelta(days=7))
        r.EndTime = fmt(now)
        r.MetricNames = ["l7Flow_request", "l7Flow_outFlux"]
        r.ZoneIds = [zone]
        r.Interval = "day"
        return json.loads(client.DescribeTimingL7AnalysisData(r).to_json_string())

    data["l7_days"], err = _call("近 7 天 L7 数据", l7)
    errors.append(err)

    month_start = now.replace(day=1, hour=0, minute=0, second=0)
    for metric in ("edgefunction_request", "acc_flux"):
        def bill(metric=metric):
            r = models.DescribeBillingDataRequest()
            r.StartTime = fmt(month_start)
            r.EndTime = fmt(now)
            r.ZoneIds = [zone]
            r.MetricName = metric
            r.Interval = "day"
            return json.loads(client.DescribeBillingData(r).to_json_string())
        data["billing"][metric], err = _call(f"本月计费 {metric}", bill)
        errors.append(err)

    with open(os.path.join(HERE, "edgeone-usage-thresholds.json"), encoding="utf-8") as f:
        thresholds = json.load(f)

    result = evaluate(data, thresholds, now)
    md = render_md(result, [e for e in errors if e], now)
    print(md)
    for var, content in (("OUT_MD", md), ("OUT_BREACH", "\n".join(result["breaches"]))):
        path = os.environ.get(var)
        if path:
            with open(path, "w", encoding="utf-8") as f:
                f.write(content + ("\n" if content else ""))
    if all(v is None for v in (data["quota"], data["l7_days"])) and not any(data["billing"].values()):
        sys.exit("✗ 四类数据一个都没读到（凭据权限不够？）——见上面的「取不到」原因")


if __name__ == "__main__":
    main()
