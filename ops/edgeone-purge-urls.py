#!/usr/bin/env python3
"""EdgeOne 按 URL 清缓存（purge_url），手动触发用。

URLS 环境变量：空格或换行分隔的完整 URL。只清这几个文件，不清整站。
返回里 FailedList 非空即失败退出（purge_url 按加速域名精确匹配，域名不对会静默进 FailedList）。
"""
import json
import os
import sys

from tencentcloud.common import credential
from tencentcloud.teo.v20220901 import models, teo_client

urls = [u for u in os.environ.get("URLS", "").split() if u]
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
