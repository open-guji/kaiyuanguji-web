#!/usr/bin/env python3
"""release-branch 回滚后清正式站 CDN（DBG）：与 deploy.yml「Purge EdgeOne CDN cache」同一口径——
purge_host kaiyuanguji.com（整站，含 www）＋ purge_url 正式站数据指针。
需要 TENCENT_SECRET_ID／TENCENT_SECRET_KEY／EDGEONE_ZONE_ID（只从环境变量读，不打印）。
FailedList 非空即失败退出。
"""
import json
import os
import sys

from tencentcloud.common import credential
from tencentcloud.teo.v20220901 import models, teo_client

cred = credential.Credential(os.environ["TENCENT_SECRET_ID"], os.environ["TENCENT_SECRET_KEY"])
client = teo_client.TeoClient(cred, "")
failed_any = False
for typ, targets in (
    ("purge_url", ["https://data.kaiyuanguji.com/latest.json"]),
    ("purge_host", ["kaiyuanguji.com"]),
):
    req = models.CreatePurgeTaskRequest()
    req.ZoneId = os.environ["EDGEONE_ZONE_ID"]
    req.Type = typ
    req.Targets = targets
    resp = json.loads(client.CreatePurgeTask(req).to_json_string())
    failed = resp.get("FailedList") or []
    print(f"{'✗' if failed else '✓'} {typ} {' '.join(targets)} JobId={resp.get('JobId')}"
          + (f" {failed}" if failed else ""))
    failed_any = failed_any or bool(failed)
sys.exit(1 if failed_any else 0)
