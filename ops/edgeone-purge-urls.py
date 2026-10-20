#!/usr/bin/env python3
"""EdgeOne 按 URL 清缓存（purge_url），手动触发用。

URLS 环境变量：空格或换行分隔的完整 URL。只清这几个文件，不清整站。
不给就清四个 h1 版本指针（正式与 staging/，数据域名取自 config/hosts.json）。
返回里 FailedList 非空即失败退出（purge_url 按加速域名精确匹配，域名不对会静默进 FailedList）。
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import hosts  # noqa: E402

from tencentcloud.common import credential
from tencentcloud.teo.v20220901 import models, teo_client

DEFAULT_URLS = [f"{base}/h1/{name}" for base in (hosts.DATA_ORIGIN, hosts.DATA_STAGING_ORIGIN)
                for name in ("manifest-root.json", "text-manifest-root.json")]

urls = [u for u in os.environ.get("URLS", "").split() if u] or DEFAULT_URLS
if not urls:
    sys.exit("✗ 没有 URL")
for u in urls:
    if not u.startswith("https://"):
        sys.exit(f"✗ 不是完整 https URL：{u}")

cred = credential.Credential(os.environ["TENCENT_SECRET_ID"], os.environ["TENCENT_SECRET_KEY"])
client = teo_client.TeoClient(cred, "")
req = models.CreatePurgeTaskRequest()
req.ZoneId = os.environ["EDGEONE_ZONE_ID"]
req.Type = "purge_url"
req.Targets = urls
resp = json.loads(client.CreatePurgeTask(req).to_json_string())
print("JobId:", resp.get("JobId"))
failed = resp.get("FailedList") or []
for u in urls:
    bad = [f for f in failed if f.get("Target") == u]
    print(("✗ " if bad else "✓ ") + u + (f"  {bad[0].get('Reason')}" if bad else ""))
if failed:
    sys.exit(1)
