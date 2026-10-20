#!/usr/bin/env python3
"""清 EdgeOne CDN 缓存里的几个数据地址（purge_url），给数据流程（data.yml）的刷新阶段用（overview#470 P1）。

只允许数据域名（config/hosts.json 的 data 与 legacyData）下的地址——这个脚本是给「数据指针」用的，不清页面、不清整站
（整站 purge 会把 300 多 MB 的数据缓存白丢，回源费贵；页面靠 Next 的按需失效，见 scripts/item-revalidate.mjs）。

新旧两个数据域名回源同一个 COS 桶，各有各的节点缓存：给其中一个域名下的地址，另一个域名下的同一路径也一起清。
两个域名在 EdgeOne 的不同站点（zone）下：
  旧域名（legacyData，旧站点）用 EDGEONE_ZONE_ID，必须有；
  新域名（data，新站点）用 EDGEONE_DATA_ZONE_ID，没配就跳过并警告（新域名的版本指针在规则引擎里本就配了节点不缓存）。

用法：python3 ops/purge-urls.py [--dry-run] <url> [<url> ...]
环境变量：TENCENT_SECRET_ID／TENCENT_SECRET_KEY／EDGEONE_ZONE_ID／EDGEONE_DATA_ZONE_ID（--dry-run 时不需要）
退出码：0 成功；1 地址不合规／调用失败；2 用法不对。
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import hosts  # noqa: E402

DATA_ORIGIN = hosts.DATA_ORIGIN + '/'
LEGACY_DATA_ORIGIN = hosts.LEGACY_DATA_ORIGIN + '/'
# (数据根, 站点 ID 的环境变量名, 是否必须)
ZONES = [(LEGACY_DATA_ORIGIN, 'EDGEONE_ZONE_ID', True)]
if DATA_ORIGIN != LEGACY_DATA_ORIGIN:
    ZONES.append((DATA_ORIGIN, 'EDGEONE_DATA_ZONE_ID', False))
ORIGINS = [o for o, _, _ in ZONES]
MAX_URLS = 20


def check_urls(urls):
    """返回错误列表（空＝通过）"""
    errors = []
    if not urls:
        errors.append('没有给任何地址')
    if len(urls) > MAX_URLS:
        errors.append(f'一次最多 {MAX_URLS} 个地址，给了 {len(urls)} 个')
    for u in urls:
        if not any(u.startswith(o) for o in ORIGINS):
            errors.append(f'只允许 {" 或 ".join(ORIGINS)} 下的地址：{u}')
        elif any(c in u for c in ' \t\r\n*'):
            errors.append(f'地址里不能有空白或通配符：{u!r}')
    return errors


def plan(urls):
    """每个地址换到每个数据域名下 → [(站点 ID 环境变量名, 是否必须, [地址…])]，按 ZONES 的顺序、去重"""
    paths = []
    for u in urls:
        o = next(o for o in ORIGINS if u.startswith(o))
        p = u[len(o):]
        if p not in paths:
            paths.append(p)
    return [(env, required, [o + p for p in paths]) for o, env, required in ZONES]


def purge(zone_id, urls):
    from tencentcloud.common import credential
    from tencentcloud.teo.v20220901 import models, teo_client

    cred = credential.Credential(os.environ['TENCENT_SECRET_ID'], os.environ['TENCENT_SECRET_KEY'])
    client = teo_client.TeoClient(cred, '')
    req = models.CreatePurgeTaskRequest()
    req.ZoneId = zone_id
    req.Type = 'purge_url'
    req.Targets = urls
    resp = client.CreatePurgeTask(req)
    body = json.loads(resp.to_json_string())
    # 域名没注册等失败不会抛异常，在 FailedList 里（2026-08 事故：purge 从未真正生效却一直"成功"）
    failed = body.get('FailedList') or []
    if failed:
        raise RuntimeError(f'FailedList 非空：{failed}')
    return body


def main(argv):
    args = [a for a in argv if a != '--dry-run']
    dry = '--dry-run' in argv
    errors = check_urls(args)
    if errors:
        for e in errors:
            print(f'❌ {e}', file=sys.stderr)
        return 2 if not args else 1
    groups = plan(args)
    if dry:
        print('dry-run，将清：')
        for env, _, urls in groups:
            for u in urls:
                print(f'  [{env}] {u}')
        return 0
    for k in ('TENCENT_SECRET_ID', 'TENCENT_SECRET_KEY', 'EDGEONE_ZONE_ID'):
        if not os.environ.get(k):
            print(f'❌ 缺环境变量 {k}', file=sys.stderr)
            return 1
    for env, required, urls in groups:
        zone = os.environ.get(env)
        if not zone:
            print(f'⚠️ 没配 {env}，跳过 {len(urls)} 个地址（{urls[0]} 等）', file=sys.stderr)
            continue
        try:
            body = purge(zone, urls)
        except Exception as e:  # noqa: BLE001 — 任何失败都要带着信息退出非零
            print(f'❌ purge 失败（{env}）：{e}', file=sys.stderr)
            return 1
        print(f'✅ 已清 {len(urls)} 个地址（{env}）：{json.dumps(body, ensure_ascii=False)[:300]}')
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
