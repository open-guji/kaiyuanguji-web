#!/usr/bin/env python3
"""清 EdgeOne CDN 缓存里的几个数据地址（purge_url），给数据流程（data.yml）的刷新阶段用（overview#470 P1）。

只允许数据域名（config/hosts.json 的 data 与 legacyData）下的地址——这个脚本是给「数据指针」用的，不清页面、不清整站
（整站 purge 会把 300 多 MB 的数据缓存白丢，回源费贵；页面靠 Next 的按需失效，见 scripts/item-revalidate.mjs）。

数据域名在 EdgeOne 新站点下，用 EDGEONE_DATA_ZONE_ID。旧数据域名（legacyData）已整体 301 到新域名，
给旧域名下的地址也收，换成新域名下的同一路径去清。

用法：python3 ops/purge-urls.py [--dry-run] [--prefix] <url> [<url> ...]
  --prefix：不按地址逐个清（purge_url，日额度 1000，11-25／11-27 两次烧光），改成把地址换成所在目录，
            按目录前缀清（purge_prefix，独立额度每天 50 次）。目录超过 MAX_PREFIXES 个时逐级并到上一层；
            不允许退到站点根（至少保留一层目录）。目录前缀会清掉其下全部缓存，只给「这个目录下的东西本来就都该刷新」的场景用。
环境变量：TENCENT_SECRET_ID／TENCENT_SECRET_KEY／EDGEONE_DATA_ZONE_ID（--dry-run 时不需要）
退出码：0 成功；1 地址不合规／调用失败；2 用法不对。
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import hosts  # noqa: E402

DATA_ORIGIN = hosts.DATA_ORIGIN + '/'
LEGACY_DATA_ORIGIN = hosts.LEGACY_DATA_ORIGIN + '/'
ZONE_ENV = 'EDGEONE_DATA_ZONE_ID'
ORIGINS = list(dict.fromkeys([DATA_ORIGIN, LEGACY_DATA_ORIGIN]))
MAX_URLS = 20
MAX_PREFIXES = 10


def check_urls(urls, max_urls=MAX_URLS):
    """返回错误列表（空＝通过）"""
    errors = []
    if not urls:
        errors.append('没有给任何地址')
    if len(urls) > max_urls:
        errors.append(f'一次最多 {max_urls} 个地址，给了 {len(urls)} 个')
    for u in urls:
        if not any(u.startswith(o) for o in ORIGINS):
            errors.append(f'只允许 {" 或 ".join(ORIGINS)} 下的地址：{u}')
        elif any(c in u for c in ' \t\r\n*'):
            errors.append(f'地址里不能有空白或通配符：{u!r}')
    return errors


def plan(urls):
    """每个地址换到新数据域名下、去重 → [地址…]"""
    paths = []
    for u in urls:
        o = next(o for o in ORIGINS if u.startswith(o))
        p = u[len(o):]
        if p not in paths:
            paths.append(p)
    return [DATA_ORIGIN + p for p in paths]


def plan_prefixes(urls, max_prefixes=MAX_PREFIXES):
    """地址 → 目录前缀（以 / 结尾）：先取所在目录，数量超限就逐级并到上一层，最浅保留一层目录"""
    dirs = []
    for u in plan(urls):
        d = u[len(DATA_ORIGIN):].rsplit('/', 1)[0] if '/' in u[len(DATA_ORIGIN):] else ''
        if d and d not in dirs:
            dirs.append(d)
    if not dirs:
        raise ValueError('这些地址都在站点根下，没有可按前缀清的目录；请按地址清')
    while len(dirs) > max_prefixes:
        parents = []
        for d in dirs:
            q = d.rsplit('/', 1)[0] if '/' in d else d
            if q not in parents:
                parents.append(q)
        if parents == dirs:
            break
        dirs = parents
    # 去掉被别的前缀包含的子目录
    dirs = [d for d in dirs if not any(o != d and d.startswith(o + '/') for o in dirs)]
    return [f'{DATA_ORIGIN}{d}/' for d in dirs]


def purge(zone_id, urls, kind='purge_url'):
    from tencentcloud.common import credential
    from tencentcloud.teo.v20220901 import models, teo_client

    cred = credential.Credential(os.environ['TENCENT_SECRET_ID'], os.environ['TENCENT_SECRET_KEY'])
    client = teo_client.TeoClient(cred, '')
    req = models.CreatePurgeTaskRequest()
    req.ZoneId = zone_id
    req.Type = kind
    req.Targets = urls
    resp = client.CreatePurgeTask(req)
    body = json.loads(resp.to_json_string())
    # 域名没注册等失败不会抛异常，在 FailedList 里（2026-08 事故：purge 从未真正生效却一直"成功"）
    failed = body.get('FailedList') or []
    if failed:
        raise RuntimeError(f'FailedList 非空：{failed}')
    return body


def main(argv):
    args = [a for a in argv if a not in ('--dry-run', '--prefix')]
    dry = '--dry-run' in argv
    by_prefix = '--prefix' in argv
    errors = check_urls(args, 100_000 if by_prefix else MAX_URLS)
    if errors:
        for e in errors:
            print(f'❌ {e}', file=sys.stderr)
        return 2 if not args else 1
    try:
        urls = plan_prefixes(args) if by_prefix else plan(args)
    except ValueError as e:
        print(f'❌ {e}', file=sys.stderr)
        return 1
    if dry:
        print('dry-run，将清：')
        for u in urls:
            print(f'  {u}')
        return 0
    for k in ('TENCENT_SECRET_ID', 'TENCENT_SECRET_KEY', ZONE_ENV):
        if not os.environ.get(k):
            print(f'❌ 缺环境变量 {k}', file=sys.stderr)
            return 1
    try:
        body = purge(os.environ[ZONE_ENV], urls, 'purge_prefix' if by_prefix else 'purge_url')
    except Exception as e:  # noqa: BLE001 — 任何失败都要带着信息退出非零
        print(f'❌ purge 失败：{e}', file=sys.stderr)
        return 1
    print(f'✅ 已清 {len(urls)} 个{"目录前缀" if by_prefix else "地址"}：{json.dumps(body, ensure_ascii=False)[:300]}')
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
