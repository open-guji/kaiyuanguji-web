#!/usr/bin/env python3
"""EdgeOne 回源相关配置只读审计：缓存键、缓存时长、回源、源站保护、加速域名、规则引擎。只读，不改。
需 TENCENT_SECRET_ID／TENCENT_SECRET_KEY、EDGEONE_DATA_ZONE_ID（和可选 EDGEONE_ZONE_ID）。输出 JSON（已去掉 ID/账号类字段不处理，不含密钥）。"""
import json, os
from tencentcloud.common import credential
from tencentcloud.teo.v20220901 import models, teo_client

cred = credential.Credential(os.environ["TENCENT_SECRET_ID"], os.environ["TENCENT_SECRET_KEY"])
client = teo_client.TeoClient(cred, "")


def call(name, **params):
    try:
        req = getattr(models, name + "Request")()
        req.from_json_string(json.dumps(params))
        resp = getattr(client, name)(req)
        return json.loads(resp.to_json_string())
    except Exception as e:
        return {"error": str(e)[:400]}


out = {}
for label, zid in (("data_zone", os.environ.get("EDGEONE_DATA_ZONE_ID")), ("site_zone", os.environ.get("EDGEONE_ZONE_ID"))):
    if not zid:
        continue
    z = {}
    s = call("DescribeZoneSetting", ZoneId=zid)
    z["setting"] = {k: s.get(k) for k in ("CacheKey", "Cache", "MaxAge", "OfflineCache", "Origin", "SmartRouting", "ClientIpHeader", "CachePrefresh", "Compression", "Https") if k in s} or s
    z["origin_protection"] = call("DescribeOriginProtection", ZoneIds=[zid])
    z["acceleration_domains"] = call("DescribeAccelerationDomains", ZoneId=zid, Limit=100, Offset=0)
    z["rules_l7"] = call("DescribeL7AccRules", ZoneId=zid, Limit=100, Offset=0)
    out[label] = z
print(json.dumps(out, ensure_ascii=False, indent=1, default=str)[:60000])
