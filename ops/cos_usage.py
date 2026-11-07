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


def list_page(sid, skey, bucket, region, prefix, marker='', delimiter=''):
    host = f'{bucket}.cos.{region}.myqcloud.com'
    params = {'max-keys': '1000'}
    if prefix:
        params['prefix'] = prefix
    if delimiter:
        params['delimiter'] = delimiter
    if marker:
        params['marker'] = marker
    url = f'https://{host}/?' + urllib.parse.urlencode(params, quote_via=urllib.parse.quote)
    for attempt in range(6):
        try:
            req = urllib.request.Request(url, headers={'Host': host, 'Authorization': sign(sid, skey, host, params)})
            with urllib.request.urlopen(req, timeout=60) as r:
                root = ET.fromstring(r.read())
            break
        except Exception:
            if attempt == 5:
                raise
            time.sleep(2 * (attempt + 1))
    ns = root.tag.split('}')[0] + '}' if root.tag.startswith('{') else ''
    objs = [(c.find(f'{ns}Key').text, int(c.find(f'{ns}Size').text)) for c in root.findall(f'{ns}Contents')]
    dirs = [c.find(f'{ns}Prefix').text for c in root.findall(f'{ns}CommonPrefixes')]
    nxt = (root.findtext(f'{ns}NextMarker') or (objs[-1][0] if objs else '')) if root.findtext(f'{ns}IsTruncated') == 'true' else ''
    return objs, dirs, nxt


def list_prefix(sid, skey, bucket, region, prefix, delimiter=''):
    """列举一个前缀下的全部：(对象列表, 子前缀列表)；delimiter 为空＝平铺列出所有对象。"""
    objs, dirs, marker = [], [], ''
    while True:
        o, d, marker = list_page(sid, skey, bucket, region, prefix, marker, delimiter)
        objs += o
        dirs += d
        if not marker:
            return objs, dirs


def groups(key):
    parts = key.split('/')
    yield 'top: ' + (parts[0] + '/' if len(parts) > 1 else '(根目录文件)')
    if parts[0] != 'iiif' and len(parts) > 2:
        yield f'sub: {parts[0]}/{parts[1]}/'
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


# 下探深度：iiif/ 下到「书/册/段」共 4 层；其它顶层到 2 层；到深度后平铺列举该前缀
MAX_DEPTH = {'iiif': 4}
DEFAULT_DEPTH = 2


def main():
    import concurrent.futures as cf, threading
    ap = argparse.ArgumentParser()
    ap.add_argument('--out')
    ap.add_argument('--workers', type=int, default=32)
    a = ap.parse_args()
    sid, skey, bucket = os.environ['COS_SECRET_ID'], os.environ['COS_SECRET_KEY'], os.environ['COS_BUCKET']
    region = os.environ.get('COS_REGION', 'ap-shanghai')
    cnt, size = defaultdict(int), defaultdict(int)
    lock = threading.Lock()
    state = {'n': 0, 'total': 0, 'tasks': 0}

    def add(key, sz):
        gs = list(groups(key))
        with lock:
            state['n'] += 1
            state['total'] += sz
            for g in gs:
                cnt[g] += 1
                size[g] += sz

    stop = threading.Event()

    def progress():
        while not stop.wait(30):
            print(f'· 已列 {state["n"]} 个对象，{state["total"] / 1e9:.1f} GB', file=sys.stderr, flush=True)

    threading.Thread(target=progress, daemon=True).start()
    # 线程池里再提交任务会占满 worker：用一层一层的方式推进，避免死锁
    with cf.ThreadPoolExecutor(a.workers) as ex:
        pending = [('', 0)]
        while pending:
            nxt = []
            def task(item):
                prefix, d = item
                top = prefix.split('/')[0]
                limit = MAX_DEPTH.get(top, DEFAULT_DEPTH)
                if prefix and d >= limit:
                    objs, _ = list_prefix(sid, skey, bucket, region, prefix)
                    for k, sz in objs:
                        add(k, sz)
                    return []
                objs, dirs = list_prefix(sid, skey, bucket, region, prefix, delimiter='/')
                for k, sz in objs:
                    add(k, sz)
                return [(dd, d + 1) for dd in dirs]
            for res in ex.map(task, pending):
                nxt += res
            pending = nxt
    stop.set()
    n, total = state['n'], state['total']
    rows = sorted(((g, cnt[g], size[g]) for g in cnt), key=lambda r: -r[2])
    lines = ['## COS 用量（只读统计）', '', f'共 {n} 个对象，{total / 1e9:.2f} GB', '', '| 前缀 | 对象数 | GB |', '|---|---|---|']
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
