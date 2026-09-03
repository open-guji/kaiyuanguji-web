"""上海云主机 (81.69.15.227) 救援脚本，跑在 GitHub 托管 runner 上。

单独成文件而不是内联进 workflow：deploy.yml 里记着一个坑——bash 双引号包裹的
python3 -c 内联脚本，只要注释里出现半角双引号就会让 shell 提前截断，后半段
Python 代码整体消失且 step 仍然 exit 0（截断后剩下的恰好是合法空程序）。
写成独立文件从根上避免这类静默失败。
"""
import os
import sys

from tencentcloud.common import credential
from tencentcloud.common.exception import TencentCloudSDKException
from tencentcloud.cvm.v20170312 import cvm_client, models

TARGET_IP = os.environ.get("INSTANCE_IP", "81.69.15.227")
ACTION = os.environ.get("ACTION", "describe")

# 上海机器，但不写死 region：子账号可能只在某些 region 有权限，
# 挨个 region 找 IP 命中的实例，顺便把鉴权错误暴露出来。
REGIONS = ["ap-shanghai", "ap-beijing", "ap-guangzhou", "ap-nanjing", "ap-chengdu"]


def make_client(region):
    cred = credential.Credential(
        os.environ["TENCENT_SECRET_ID"], os.environ["TENCENT_SECRET_KEY"]
    )
    return cvm_client.CvmClient(cred, region)


def find_instance():
    """在各 region 里按公网 IP 找实例。返回 (region, instance) 或 (None, None)。"""
    auth_errors = []
    for region in REGIONS:
        try:
            resp = make_client(region).DescribeInstances(models.DescribeInstancesRequest())
        except TencentCloudSDKException as exc:
            # 鉴权 / 权限不足是本次最可能的结果，单独收集后统一报告
            auth_errors.append("  {}: {}".format(region, exc))
            continue

        for inst in resp.InstanceSet:
            if TARGET_IP in (inst.PublicIpAddresses or []):
                return region, inst

    if auth_errors:
        print("❌ 所有 region 都调不通 CVM API：", file=sys.stderr)
        print("\n".join(auth_errors), file=sys.stderr)
        print(
            "\n提示：TENCENT_SECRET_* 这个子账号原本只为 EdgeOne purge 授权。"
            "\n若报 UnauthorizedOperation / AuthFailure，说明它没有 CVM 权限，"
            "\n需要在腾讯云控制台给该子账号加 QcloudCVMReadOnlyAccess（查看）"
            "\n或 QcloudCVMFullAccess（重启），或改用控制台 VNC 人工处理。",
            file=sys.stderr,
        )
    return None, None


def describe(inst, region):
    print("region        :", region)
    print("InstanceId    :", inst.InstanceId)
    print("InstanceName  :", inst.InstanceName)
    print("InstanceState :", inst.InstanceState)
    print("公网 IP       :", ", ".join(inst.PublicIpAddresses or []))
    print("机型/配置     : {} | {} core | {} MB".format(inst.InstanceType, inst.CPU, inst.Memory * 1024))
    print("到期时间      :", inst.ExpiredTime)
    print("计费模式      :", inst.InstanceChargeType)
    if inst.LatestOperation:
        print("最近操作      : {} → {}".format(inst.LatestOperation, inst.LatestOperationState))

    state = inst.InstanceState
    print()
    if state == "RUNNING":
        print("⚠️  实例状态是 RUNNING，但外部 ICMP/22/80/443/7700 全不通。")
        print("    → 属于系统内部卡死（2GB 无 swap，OOM 拖垮整机是已知场景），")
        print("      控制台看着是正常的。建议先看监控曲线，再走 reboot。")
    elif state == "STOPPED":
        print("→ 实例已关机。用 start 开机。若是欠费停服，先充值。")
    elif state in ("EXPIRED", "PROTECTIVELY_ISOLATED"):
        print("→ 实例已到期/被隔离（欠费）。必须先在控制台续费，API 无法恢复。")
    else:
        print("→ 状态 {}，等它稳定后再操作。".format(state))


def main():
    region, inst = find_instance()
    if inst is None:
        if region is None:
            print("\n未能定位实例（可能无权限，或 IP 不在已扫描的 region）。", file=sys.stderr)
        sys.exit(1)

    describe(inst, region)

    if ACTION == "describe":
        return

    client = make_client(region)
    if ACTION == "reboot":
        if inst.InstanceState != "RUNNING":
            print("\n实例不是 RUNNING（当前 {}），reboot 无意义，改用 start。".format(inst.InstanceState))
            sys.exit(1)
        req = models.RebootInstancesRequest()
        req.InstanceIds = [inst.InstanceId]
        # 卡死的机器软重启多半没反应，直接用硬关机语义
        req.StopType = "HARD"
        client.RebootInstances(req)
        print("\n✅ 已下发硬重启。等 2-3 分钟后再探 22/7700 端口。")
    elif ACTION == "start":
        if inst.InstanceState == "RUNNING":
            print("\n实例已经是 RUNNING，无需 start。")
            return
        req = models.StartInstancesRequest()
        req.InstanceIds = [inst.InstanceId]
        client.StartInstances(req)
        print("\n✅ 已下发开机。等 2-3 分钟后再探端口。")


if __name__ == "__main__":
    main()
