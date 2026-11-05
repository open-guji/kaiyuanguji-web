#!/usr/bin/env python3
"""COS 数据桶按前缀统计用量（只读：只发 GET 列举，不写不删）。

用法（需 COS_SECRET_ID／COS_SECRET_KEY／COS_BUCKET，可选 COS_REGION）：
    python3 ops/cos_usage.py [--out report.json]

分组：
- 顶层目录：第一段（current/、h1/、proof/、iiif/、v/、staging/ …）
- iiif/<书>/：每本书
- iiif/96mid1ogzk/<册>/<段>/：四庫總目按图路径段细分；段是纯数字页序的归「旧路径（页序直放）」，
  其余（qiefen2、wyg …）按段名归；册目录下的 manifest.json 归「manifest」
输出对象数与 GB（1 GB = 10^9 字节）。
"""
import argparse, hashlib, hmac, json, os, sys, time, urllib.parse, urllib.request, xml.etree.ElementTree as ET
from collections import defaultdict


def sign(sid, skey, host, params, ttl=900):
    start = int(time.time()) - 60
    key_time = f'{start};{start + ttl + 60}'
    sign_key = hmac.new(skey.encode(), key_time.encode(), hashlib.sha1).hexdigest()
    ps = sorted((urllib.parse.quote(k.lower(), safe='-_.~'), urllib.parse.quote(str(v), safe='-_.~')) for k, v in params.items())
    hs = [('host', urllib.parse.quote(host, safe='-_.~'))]
    http_string = 'get\n/\n' + '&'.join(f'{k}={v}' for k, v in ps) + '\n' + '&'.join(f'{k}={v}' for k, v in hs) + '\n'
    sts = f'sha1\n{key_time}\n{hashlib.sha1(http_string.encode()).hexdigest()}\n'
    sig = hmac.new(sign_key.encode(), sts.encode(), hashlib.sha1).hexdigest()
    return (f'q-sign-algorithm=sha1&q-ak={sid}&q-sign-time={key_time}&q-key-time={key_time}'
            f'&q-header-list=host&q-url-param-list={";".join(k for k, _ in ps)}&q-signature={sig}')


def list_all(sid, skey, bucket, region):
    host = f'{bucket}.cos.{region}.myqcloud.com'
    marker = ''
    while True:
        params = {'max-keys': '1000'}
        if marker:
            params['marker'] = marker
        url = f'https://{host}/?' + urllib.parse.urlencode(params, quote_via=urllib.parse.quote)
        req = urllib.request.Request(url, headers={'Host': host, 'Authorization': sign(sid, skey, host, params)})
        for attempt in range(5):
            try:
                with urllib.request.urlopen(req, timeout=60) as r:
                    root = ET.fromstring(r.read())
                break
            except Exception:
                if attempt == 4:
                    raise
                time.sleep(2 * (attempt + 1))
        ns = root.tag.split('}')[0] + '}' if root.tag.startswith('{') else ''
        for c in root.findall(f'{ns}Contents'):
            yield c.find(f'{ns}Key').text, int(c.find(f'{ns}Size').text)
        if root.findtext(f'{ns}IsTruncated') == 'true':
            marker = root.findtext(f'{ns}NextMarker') or ''
            if not marker:
                return
        else:
            return


def groups(key):
    parts = key.split('/')
    yield 'top: ' + (parts[0] + '/' if len(parts) > 1 else '(根目录文件)')
    if parts[0] == 'iiif' and len(parts) > 2:
        yield f'iiif/{parts[1]}/'
        if parts[1] == '96mid1ogzk':
            if len(parts) >= 5 and parts[2].isdigit():
                seg = parts[3]
                yield 'siku: ' + ('旧路径（页序直放，如 CADAL）' if seg.isdigit() else seg + '/')
            elif len(parts) >= 4 and parts[3] == 'manifest.json':
                yield 'siku: manifest'
            elif len(parts) == 3:
                yield 'siku: 书级文件'
            else:
                yield 'siku: 其它'


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out')
    a = ap.parse_args()
    sid, skey, bucket = os.environ['COS_SECRET_ID'], os.environ['COS_SECRET_KEY'], os.environ['COS_BUCKET']
    region = os.environ.get('COS_REGION', 'ap-shanghai')
    cnt, size = defaultdict(int), defaultdict(int)
    n = total = 0
    for key, sz in list_all(sid, skey, bucket, region):
        n += 1
        total += sz
        for g in groups(key):
            cnt[g] += 1
            size[g] += sz
        if n % 200000 == 0:
            print(f'· 已列 {n} 个对象，{total / 1e9:.1f} GB', file=sys.stderr, flush=True)
    rows = sorted(((g, cnt[g], size[g]) for g in cnt), key=lambda r: -r[2])
    lines = [f'## COS 用量（只读统计）', '', f'共 {n} 个对象，{total / 1e9:.2f} GB', '', '| 前缀 | 对象数 | GB |', '|---|---|---|']
    lines += [f'| {g} | {c} | {s / 1e9:.2f} |' for g, c, s in rows]
    text = '\n'.join(lines)
    print(text)
    summary = os.environ.get('GITHUB_STEP_SUMMARY')
    if summary:
        with open(summary, 'a', encoding='utf-8') as f:
            f.write(text + '\n')
    if a.out:
        with open(a.out, 'w', encoding='utf-8') as f:
            json.dump({'objects': n, 'bytes': total, 'groups': [{'prefix': g, 'objects': c, 'bytes': s} for g, c, s in rows]}, f, ensure_ascii=False, indent=1)


if __name__ == '__main__':
    main()
