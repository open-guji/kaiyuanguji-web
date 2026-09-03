"""列出该子账号在所有 region 能看到的全部 CVM 实例（只读排查用）。

describe 按公网 IP 匹配不到实例时用这个：可能实例在别的 region，
也可能公网出口是弹性 IP / NAT，不体现在 PublicIpAddresses 里。
"""
import os
import sys

from tencentcloud.common import credential
from tencentcloud.common.exception import TencentCloudSDKException
from tencentcloud.cvm.v20170312 import cvm_client, models


def main():
    cred = credential.Credential(
        os.environ["TENCENT_SECRET_ID"], os.environ["TENCENT_SECRET_KEY"]
    )

    # 先动态取全部 region，别再靠手写清单漏掉
    try:
        regions = [
            r.Region
            for r in cvm_client.CvmClient(cred, "ap-shanghai")
            .DescribeRegions(models.DescribeRegionsRequest())
            .RegionSet
        ]
    except TencentCloudSDKException as exc:
        print("DescribeRegions 失败：{}".format(exc), file=sys.stderr)
        sys.exit(1)

    print("可见 region 数：{}\n".format(len(regions)))
    total = 0
    for region in regions:
        try:
            resp = cvm_client.CvmClient(cred, region).DescribeInstances(
                models.DescribeInstancesRequest()
            )
        except TencentCloudSDKException as exc:
            print("{:16s} ERROR {}".format(region, exc))
            continue

        if resp.TotalCount == 0:
            continue
        total += resp.TotalCount
        print("=== {} ({} 台)".format(region, resp.TotalCount))
        for i in resp.InstanceSet:
            print(
                "  {} | {} | {} | pub={} | pri={} | {}core/{}GB | 到期 {}".format(
                    i.InstanceId,
                    i.InstanceName,
                    i.InstanceState,
                    ",".join(i.PublicIpAddresses or []) or "-",
                    ",".join(i.PrivateIpAddresses or []) or "-",
                    i.CPU,
                    i.Memory,
                    i.ExpiredTime,
                )
            )

    print("\n合计 {} 台".format(total))
    if total == 0:
        print(
            "\n该子账号在所有 region 都看不到任何 CVM 实例。"
            "\n说明它没有 CVM 权限（只授了 EdgeOne），或机器挂在另一个腾讯云账号下。"
            "\n→ 只能走腾讯云控制台人工处理。"
        )


if __name__ == "__main__":
    main()
