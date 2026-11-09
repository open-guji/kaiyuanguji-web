#!/usr/bin/env python3
"""四庫總目换图源后的旧书影（CADAL 旧路径）：默认只列清单（dry-run），加 --delete 才删。

匹配键名：^iiif/96mid1ogzk/\\d{2}/\\d{4}[a-d]?/ ——换源前页图与 info.json（页序直放，含 0105a–d 之类带字母的页）。
不匹配：册目录下的 manifest.json、qiefen2/、wyg/、其它书、书级 Collection。

用法（需 COS_SECRET_ID／COS_SECRET_KEY／COS_BUCKET）：
    python3 ops/cos_siku_old.py --keys-out keys.txt            # dry-run：只列
    python3 ops/cos_siku_old.py --delete --keys-out keys.txt   # 真删（先重新列，只删当次列出的匹配键）
"""
import argparse, concurrent.futures as cf, hashlib, hmac, os, re, sys, time, urllib.error, urllib.parse, urllib.request
from collections import defaultdict

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cos_usage  # noqa: E402


def cos_authorization(secret_id, secret_key, method, path, headers, ttl=900):
    # 与 ops/iiif/siku_zongmu_iiif.py 的同名函数一致（那个模块要 PIL，这里不引）：只签 Host
    start = int(time.time()) - 60
    key_time = f'{start};{start + ttl + 60}'
    sign_key = hmac.new(secret_key.encode(), key_time.encode(), hashlib.sha1).hexdigest()
    hs = sorted((urllib.parse.quote(k.lower(), safe='-_.~'), urllib.parse.quote(str(v), safe='-_.~')) for k, v in headers.items())
    http_string = f'{method.lower()}\n{path}\n\n' + '&'.join(f'{k}={v}' for k, v in hs) + '\n'
    sts = f'sha1\n{key_time}\n{hashlib.sha1(http_string.encode()).hexdigest()}\n'
    sig = hmac.new(sign_key.encode(), sts.encode(), hashlib.sha1).hexdigest()
    return (f'q-sign-algorithm=sha1&q-ak={secret_id}&q-sign-time={key_time}&q-key-time={key_time}'
            f'&q-header-list={";".join(k for k, _ in hs)}&q-url-param-list=&q-signature={sig}')

PATTERNS = {
    'cadal': re.compile(r'^iiif/96mid1ogzk/\d{2}/\d{4}[a-d]?/'),
    # 11-09 sheldon 同意：siku-qiefen-v2 旧书影（A20 核过线上无引用）；不碰 manifest.json、wyg/、src/
    'qiefen2': re.compile(r'^iiif/96mid1ogzk/\d{2}/qiefen2/'),
}
PAT = PATTERNS['cadal']
VOLS = [f'{v:02d}' for v in range(1, 100)]


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
    ap.add_argument('--delete', action='store_true')
    ap.add_argument('--keys-out')
    ap.add_argument('--pattern', choices=sorted(PATTERNS), default='cadal')
    a = ap.parse_args()
    pat = PATTERNS[a.pattern]
    sid, skey, bucket = os.environ['COS_SECRET_ID'], os.environ['COS_SECRET_KEY'], os.environ['COS_BUCKET']
    region = os.environ.get('COS_REGION', 'ap-shanghai')

    def list_vol(v):
        objs, _ = cos_usage.list_prefix(sid, skey, bucket, region, f'iiif/96mid1ogzk/{v}/')
        return [(k, s) for k, s in objs if pat.match(k)]

    hits = []
    with cf.ThreadPoolExecutor(16) as ex:
        for res in ex.map(list_vol, VOLS):
            hits += res
    hits.sort()
    per_vol, letters = defaultdict(lambda: [0, 0]), 0
    for k, s in hits:
        v = k.split('/')[2]
        per_vol[v][0] += 1
        per_vol[v][1] += s
        if a.pattern == 'cadal' and not k.split('/')[3].isdigit():
            letters += 1
    total = sum(s for _, s in hits)
    lines = [f'## 四庫總目旧书影清单（{"删除" if a.delete else "dry-run，未删"}）', '',
             f'匹配 {len(hits)} 个对象，{total / 1e9:.3f} GB（其中带字母页目录下 {letters} 个）', '',
             '| 册 | 对象数 | MB |', '|---|---|---|']
    lines += [f'| {v} | {c} | {s / 1e6:.1f} |' for v, (c, s) in sorted(per_vol.items())]
    lines += ['', '前 5 个键：'] + [f'- `{k}`' for k, _ in hits[:5]] + ['后 5 个键：'] + [f'- `{k}`' for k, _ in hits[-5:]]
    if a.keys_out:
        with open(a.keys_out, 'w', encoding='utf-8') as f:
            f.write('\n'.join(k for k, _ in hits) + '\n')
    if a.delete:
        done = 0
        with cf.ThreadPoolExecutor(32) as ex:
            for ok in ex.map(lambda k: delete_key(sid, skey, bucket, region, k), [k for k, _ in hits]):
                done += 1 if ok else 0
                if done % 10000 == 0:
                    print(f'· 已删 {done}', file=sys.stderr, flush=True)
        left = sum(len(list_vol(v)) for v in VOLS)
        lines += ['', f'实删 {done} 个对象，{total / 1e9:.3f} GB；复查剩余匹配 {left} 个']
    text = '\n'.join(lines)
    print(text)
    summary = os.environ.get('GITHUB_STEP_SUMMARY')
    if summary:
        with open(summary, 'a', encoding='utf-8') as f:
            f.write(text + '\n')


if __name__ == '__main__':
    main()
