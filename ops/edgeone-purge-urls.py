#!/usr/bin/env python3
"""EdgeOne 按 URL 清缓存（purge_url），手动触发用。

URLS 环境变量：空格或换行分隔的完整 URL。只清这几个文件，不清整站。
不给就清数据域名下的四个 h1 版本指针（正式与 staging/，域名取自 config/hosts.json；旧数据域名已整体 301 到新域名，不用再清）。
新数据域名（data）用 EDGEONE_DATA_ZONE_ID（新站点），其余用 EDGEONE_ZONE_ID（旧站点）。
返回里 FailedList 非空即失败退出（purge_url 按加速域名精确匹配，域名不对会静默进 FailedList）。
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import hosts  # noqa: E402

from tencentcloud.common import credential
from tencentcloud.teo.v20220901 import models, teo_client

DEFAULT_URLS = [f"{base}/h1/{name}" for base in (hosts.DATA_ORIGIN, hosts.DATA_ORIGIN + "/staging")
                for name in ("manifest-root.json", "text-manifest-root.json")]

urls = [u for u in os.environ.get("URLS", "").split() if u] or DEFAULT_URLS
for u in urls:
    if not u.startswith("https://"):
        sys.exit(f"✗ 不是完整 https URL：{u}")


def zone_env(u):
    """新数据域名在新站点（EDGEONE_DATA_ZONE_ID），其余（含旧数据域名）在旧站点"""
    if hosts.DATA_ORIGIN != hosts.LEGACY_DATA_ORIGIN and u.startswith(hosts.DATA_ORIGIN + "/"):
        return "EDGEONE_DATA_ZONE_ID"
    return "EDGEONE_ZONE_ID"


groups = {}
for u in urls:
    groups.setdefault(zone_env(u), []).append(u)

cred = credential.Credential(os.environ["TENCENT_SECRET_ID"], os.environ["TENCENT_SECRET_KEY"])
client = teo_client.TeoClient(cred, "")
bad_any = False
for env, targets in groups.items():
    if not os.environ.get(env):
        print(f"✗ 没配 {env}，这些没清：{' '.join(targets)}")
        bad_any = True
        continue
    req = models.CreatePurgeTaskRequest()
    req.ZoneId = os.environ[env]
    req.Type = "purge_url"
    req.Targets = targets
    resp = json.loads(client.CreatePurgeTask(req).to_json_string())
    print(f"JobId（{env}）:", resp.get("JobId"))
    failed = resp.get("FailedList") or []
    for u in targets:
        bad = [f for f in failed if f.get("Target") == u]
        print(("✗ " if bad else "✓ ") + u + (f"  {bad[0].get('Reason')}" if bad else ""))
    bad_any = bad_any or bool(failed)
if bad_any:
    sys.exit(1)
