#!/usr/bin/env python3
"""COS 整前缀清理：默认 dry-run（只列对象数与 GB），加 --delete 才删。

只允许白名单前缀（ALLOWED），免得手滑清掉正式数据。当前白名单：staging/（测试站／演练的数据副本，
测试站构建已按 SPLIT 读正式前缀，不读它）。

用法（需 COS_SECRET_ID／COS_SECRET_KEY／COS_BUCKET）：
    python3 ops/cos_prefix_delete.py --prefix staging/             # dry-run
    python3 ops/cos_prefix_delete.py --prefix staging/ --delete    # 真删（逐个 DELETE，可重跑）
"""
import argparse, concurrent.futures as cf, hashlib, hmac, os, sys, time, urllib.error, urllib.parse, urllib.request
from collections import defaultdict

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cos_usage  # noqa: E402

ALLOWED = ('staging/',)
# 不删的键（Deploy 11-05 要求保留四个小指针文件）
KEEP = {
    'staging/': {'staging/web.json', 'staging/latest.json', 'staging/h1/manifest-root.json', 'staging/h1/text-manifest-root.json'},
}
LIST_DEPTH = 3  # 先按前缀逐层下探到这么深，再对每个前缀平铺列举，并行起来快


def cos_authorization(secret_id, secret_key, method, path, headers, ttl=900):
    start = int(time.time()) - 60
    key_time = f'{start};{start + ttl + 60}'
    sign_key = hmac.new(secret_key.encode(), key_time.encode(), hashlib.sha1).hexdigest()
    hs = sorted((urllib.parse.quote(k.lower(), safe='-_.~'), urllib.parse.quote(str(v), safe='-_.~')) for k, v in headers.items())
    http_string = f'{method.lower()}\n{path}\n\n' + '&'.join(f'{k}={v}' for k, v in hs) + '\n'
    sts = f'sha1\n{key_time}\n{hashlib.sha1(http_string.encode()).hexdigest()}\n'
    sig = hmac.new(sign_key.encode(), sts.encode(), hashlib.sha1).hexdigest()
    return (f'q-sign-algorithm=sha1&q-ak={secret_id}&q-sign-time={key_time}&q-key-time={key_time}'
            f'&q-header-list={";".join(k for k, _ in hs)}&q-url-param-list=&q-signature={sig}')


def delete_key(sid, skey, bucket, region, key):
    host = f'{bucket}.cos.{region}.myqcloud.com'
    path = '/' + key
    for attempt in range(6):
        req = urllib.request.Request(f'https://{host}{urllib.parse.quote(path, safe="/,")}', method='DELETE',
                                     headers={'Host': host, 'Authorization': cos_authorization(sid, skey, 'DELETE', path, {'Host': host})})
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                r.read()
            return True
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return True
            if attempt == 5:
                raise
        except Exception:
            if attempt == 5:
                raise
        time.sleep(2 * (attempt + 1))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--prefix', required=True)
    ap.add_argument('--delete', action='store_true')
    a = ap.parse_args()
    if a.prefix not in ALLOWED:
        raise SystemExit(f'❌ 前缀 {a.prefix!r} 不在白名单 {ALLOWED}')
    sid, skey, bucket = os.environ['COS_SECRET_ID'], os.environ['COS_SECRET_KEY'], os.environ['COS_BUCKET']
    region = os.environ.get('COS_REGION', 'ap-shanghai')

    # 1) 并行列举：逐层下探到 LIST_DEPTH，到深度或没有子前缀就平铺列
    pending = [(a.prefix, 0)]
    keys = []  # (key, size)
    with cf.ThreadPoolExecutor(32) as ex:
        while pending:
            def task(item):
                prefix, d = item
                if d >= LIST_DEPTH:
                    objs, _ = cos_usage.list_prefix(sid, skey, bucket, region, prefix)
                    return objs, []
                objs, dirs = cos_usage.list_prefix(sid, skey, bucket, region, prefix, delimiter='/')
                return objs, [(x, d + 1) for x in dirs]
            nxt = []
            for objs, dirs in ex.map(task, pending):
                keys += objs
                nxt += dirs
            pending = nxt
            print(f'· 已列 {len(keys)} 个对象', file=sys.stderr, flush=True)
    if any(not k.startswith(a.prefix) for k, _ in keys):
        raise SystemExit('❌ 列出了前缀之外的键，停止')
    keep = KEEP.get(a.prefix, set())
    kept = [(k, s) for k, s in keys if k in keep]
    keys = [(k, s) for k, s in keys if k not in keep]
    total = sum(s for _, s in keys)
    per = defaultdict(lambda: [0, 0])
    for k, s in keys:
        g = '/'.join(k.split('/')[:2]) + '/'
        per[g][0] += 1
        per[g][1] += s
    lines = [f'## {a.prefix} {"删除" if a.delete else "dry-run（未删）"}', '', f'待删 {len(keys)} 个对象，{total / 1e9:.3f} GB；保留 {len(kept)} 个：{", ".join(sorted(k for k, _ in kept))}', '',
             '| 子前缀 | 对象数 | GB |', '|---|---|---|']
    lines += [f'| {g} | {c} | {s / 1e9:.3f} |' for g, (c, s) in sorted(per.items(), key=lambda r: -r[1][1])]
    if a.delete:
        done = 0
        ks = [k for k, _ in keys]
        with cf.ThreadPoolExecutor(64) as ex:
            for ok in ex.map(lambda k: delete_key(sid, skey, bucket, region, k), ks):
                done += 1 if ok else 0
                if done % 50000 == 0:
                    print(f'· 已删 {done}', file=sys.stderr, flush=True)
        left, _ = cos_usage.list_prefix(sid, skey, bucket, region, a.prefix)
        lines += ['', f'实删 {done} 个对象，{total / 1e9:.3f} GB；复查剩余 {len(left)} 个']
    text = '\n'.join(lines)
    print(text)
    summary = os.environ.get('GITHUB_STEP_SUMMARY')
    if summary:
        with open(summary, 'a', encoding='utf-8') as f:
            f.write(text + '\n')


if __name__ == '__main__':
    main()
