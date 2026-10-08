#!/usr/bin/env python3
"""清 EdgeOne CDN 缓存里的几个数据地址（purge_url），给数据流程（data.yml）的刷新阶段用（overview#470 P1）。

只允许 https://data.kaiyuanguji.com/ 下的地址——这个脚本是给「数据指针」用的，不清页面、不清整站
（整站 purge 会把 300 多 MB 的数据缓存白丢，回源费贵；页面靠 Next 的按需失效，见 scripts/item-revalidate.mjs）。

用法：python3 ops/purge-urls.py [--dry-run] <url> [<url> ...]
环境变量：TENCENT_SECRET_ID／TENCENT_SECRET_KEY／EDGEONE_ZONE_ID（--dry-run 时不需要）
退出码：0 成功；1 地址不合规／调用失败；2 用法不对。
"""
import json
import os
import sys

DATA_ORIGIN = 'https://data.kaiyuanguji.com/'
MAX_URLS = 20


def check_urls(urls):
    """返回错误列表（空＝通过）"""
    errors = []
    if not urls:
        errors.append('没有给任何地址')
    if len(urls) > MAX_URLS:
        errors.append(f'一次最多 {MAX_URLS} 个地址，给了 {len(urls)} 个')
    for u in urls:
        if not u.startswith(DATA_ORIGIN):
            errors.append(f'只允许 {DATA_ORIGIN} 下的地址：{u}')
        elif any(c in u for c in ' \t\r\n*'):
            errors.append(f'地址里不能有空白或通配符：{u!r}')
    return errors


def purge(urls):
    from tencentcloud.common import credential
    from tencentcloud.teo.v20220901 import models, teo_client

    cred = credential.Credential(os.environ['TENCENT_SECRET_ID'], os.environ['TENCENT_SECRET_KEY'])
    client = teo_client.TeoClient(cred, '')
    req = models.CreatePurgeTaskRequest()
    req.ZoneId = os.environ['EDGEONE_ZONE_ID']
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
    if dry:
        print('dry-run，将清：')
        for u in args:
            print(f'  {u}')
        return 0
    for k in ('TENCENT_SECRET_ID', 'TENCENT_SECRET_KEY', 'EDGEONE_ZONE_ID'):
        if not os.environ.get(k):
            print(f'❌ 缺环境变量 {k}', file=sys.stderr)
            return 1
    try:
        body = purge(args)
    except Exception as e:  # noqa: BLE001 — 任何失败都要带着信息退出非零
        print(f'❌ purge 失败：{e}', file=sys.stderr)
        return 1
    print(f'✅ 已清 {len(args)} 个地址：{json.dumps(body, ensure_ascii=False)[:300]}')
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
