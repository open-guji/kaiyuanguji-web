"""EdgeOne 用量检查的纯函数部分（取数在 edgeone_usage.py；这里不联网，便于单测）。"""
import calendar


def _sum_series(resp, metric):
    """从 DescribeTimingL7AnalysisData 响应里把某指标按天累加成 [(time, value)]。取不到返回 None。"""
    if not resp:
        return None
    for d in resp.get("Data") or []:
        for tv in d.get("TypeValue") or []:
            if tv.get("MetricName") == metric:
                return [(p.get("Timestamp"), p.get("Value") or 0) for p in (tv.get("Detail") or [])]
    return None


def _billing_total(resp):
    """DescribeBillingData：把各数据点的 Value 加起来；响应没有数据返回 None（区别于 0）。"""
    if not resp:
        return None
    pts = resp.get("Data") or []
    if not pts:
        return None
    total = 0
    for series in pts:
        for p in series.get("Data") or [series]:
            v = p.get("Value")
            if isinstance(v, (int, float)):
                total += v
    return total


def evaluate(data, thresholds, now):
    """返回 {"rows": [...], "breaches": [...]}。rows 给报告用，breaches 是超阈值的一行行说明。"""
    rows, breaches = [], []

    # 1. 清缓存额度
    q = (data.get("quota") or {}).get("PurgeQuota")
    if q is None:
        rows.append(("清缓存额度", "取不到", ""))
    else:
        warn = thresholds["purgeUrlDaily"]["warnRatio"]
        for item in q:
            daily, avail = item.get("Daily"), item.get("DailyAvailable")
            if daily is None or avail is None or daily <= 0:
                continue
            used = daily - avail
            rows.append((f"清缓存 {item.get('Type')}（每日）", f"已用 {used} / {daily}", f"剩 {avail}"))
            if item.get("Type") == "purge_url" and used / daily > warn:
                breaches.append(f"清缓存 purge_url 今日已用 {used}/{daily}（超过 {int(warn * 100)}%）")

    # 2. 近 7 天 L7
    req = _sum_series(data.get("l7_days"), "l7Flow_request")
    flux = _sum_series(data.get("l7_days"), "l7Flow_outFlux")
    if req is None and flux is None:
        rows.append(("近 7 天 L7 请求／响应流量", "取不到", ""))
    else:
        if req is not None:
            rows.append(("近 7 天 L7 请求数", f"{sum(v for _, v in req):,}", "按天：" + " ".join(f"{int(v):,}" for _, v in req)))
        if flux is not None:
            rows.append(("近 7 天 L7 响应流量", f"{sum(v for _, v in flux) / 1e9:.2f} GB", "按天 GB：" + " ".join(f"{v / 1e9:.2f}" for _, v in flux)))

    # 3. 本月计费
    fn = _billing_total((data.get("billing") or {}).get("edgefunction_request"))
    acc = _billing_total((data.get("billing") or {}).get("acc_flux"))
    days_in_month = calendar.monthrange(now.year, now.month)[1]
    elapsed = max(now.day - 1 + now.hour / 24, 0.5)
    if fn is None:
        rows.append(("本月边缘函数请求数", "取不到", "Pages 云函数调用可能不计在这项里，以控制台为准"))
    else:
        proj = fn / elapsed * days_in_month
        t = thresholds["functionRequestsMonth"]
        rows.append(("本月边缘函数请求数", f"{int(fn):,}", f"按当前速率月底约 {int(proj):,}（上限 {t['limit']:,}）"))
        if max(fn, proj) > t["limit"] * t["warnRatio"]:
            breaches.append(f"函数请求数本月已 {int(fn):,}、月底预计 {int(proj):,}，超过上限 {t['limit']:,} 的 {int(t['warnRatio'] * 100)}%")
    if acc is None:
        rows.append(("本月内容加速流量", "取不到", ""))
    else:
        rows.append(("本月内容加速流量", f"{acc / 1e9:.2f} GB", ""))

    return {"rows": rows, "breaches": breaches}


def render_md(result, errors, now):
    lines = [f"## EdgeOne 用量（{now.strftime('%Y-%m-%d %H:%M')} 北京时间）", "", "| 项目 | 数值 | 备注 |", "|---|---|---|"]
    for name, val, note in result["rows"]:
        lines.append(f"| {name} | {val} | {note} |")
    if result["breaches"]:
        lines += ["", "### 超阈值", *[f"- {b}" for b in result["breaches"]]]
    if errors:
        lines += ["", "### 取数失败（原因）", *[f"- {e}" for e in errors]]
    return "\n".join(lines)
