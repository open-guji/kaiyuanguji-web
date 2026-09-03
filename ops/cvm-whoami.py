"""确认 TENCENT_SECRET_* 属于哪个腾讯云账号（国内版 vs 国际版）。

2026-09-03/04：给国内账号授了 QcloudCVMReadOnlyAccess 后，CVM 仍然
列不到任何实例。怀疑这组凭证属于 EdgeOne 国际版账号（indexer/.env.example
明确写着「两套账号独立，凭证不通用」），那么在国内账号上授权自然不生效。

GetUserAppId / DescribeRegions 在两版的 endpoint 不同，用它反查归属。
"""
import os
import sys

from tencentcloud.common import credential
from tencentcloud.common.exception import TencentCloudSDKException
from tencentcloud.common.profile.client_profile import ClientProfile
from tencentcloud.common.profile.http_profile import HttpProfile
from tencentcloud.cam.v20190116 import cam_client, models as cam_models

cred = credential.Credential(
    os.environ["TENCENT_SECRET_ID"], os.environ["TENCENT_SECRET_KEY"]
)

for label, endpoint in [
    ("国内版 tencentcloudapi.com", "cam.tencentcloudapi.com"),
    ("国际版 intl.tencentcloudapi.com", "cam.intl.tencentcloudapi.com"),
]:
    http = HttpProfile()
    http.endpoint = endpoint
    prof = ClientProfile()
    prof.httpProfile = http
    try:
        client = cam_client.CamClient(cred, "ap-shanghai", prof)
        resp = client.GetUserAppId(cam_models.GetUserAppIdRequest())
        print("✅ {}: AppId={} Uin={} OwnerUin={}".format(
            label, resp.AppId, resp.Uin, resp.OwnerUin))
    except TencentCloudSDKException as exc:
        print("❌ {}: {}".format(label, str(exc)[:160]))
