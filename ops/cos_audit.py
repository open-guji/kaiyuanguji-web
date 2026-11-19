#!/usr/bin/env python3
"""COS 只读审计：桶列表、生命周期规则、版本控制、未完成分片上传。只发 GET，不写不删。
需 COS_SECRET_ID／COS_SECRET_KEY／COS_BUCKET，可选 COS_REGION。输出 JSON 到 stdout。"""
import hashlib, hmac, json, os, sys, time, urllib.parse, urllib.request, urllib.error, xml.etree.ElementTree as ET


def sign(sid, skey, host, params, ttl=900):
    start = int(time.time()) - 60
    key_time = f'{start};{start + ttl + 60}'
    sign_key = hmac.new(skey.encode(), key_time.encode(), hashlib.sha1).hexdigest()
    ps = sorted((urllib.parse.quote(k.lower(), safe='-_.~'), urllib.parse.quote(str(v), safe='-_.~')) for k, v in params.items())
    http_string = 'get\n/\n' + '&'.join(f'{k}={v}' for k, v in ps) + '\nhost=' + urllib.parse.quote(host, safe='-_.~') + '\n'
    sts = f'sha1\n{key_time}\n{hashlib.sha1(http_string.encode()).hexdigest()}\n'
    sig = hmac.new(sign_key.encode(), sts.encode(), hashlib.sha1).hexdigest()
    return (f'q-sign-algorithm=sha1&q-ak={sid}&q-sign-time={key_time}&q-key-time={key_time}'
            f'&q-header-list=host&q-url-param-list={";".join(k for k, _ in ps)}&q-signature={sig}')


def get(sid, skey, host, params):
    q = urllib.parse.urlencode(params, quote_via=urllib.parse.quote) if params else ''
    url = f'https://{host}/' + (('?' + q) if q else '')
    # 无值参数（?lifecycle）要保留
    for k, v in params.items():
        if v == '':
            url = url.replace(f'{k}=', k)
    req = urllib.request.Request(url, headers={'Host': host, 'Authorization': sign(sid, skey, host, params)})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.status, r.read().decode('utf-8', 'replace')
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode('utf-8', 'replace')[:600]


def strip(xml_text):
    try:
        root = ET.fromstring(xml_text)
    except Exception:
        return xml_text[:800]
    def conv(e):
        tag = e.tag.split('}')[-1]
        kids = [conv(c) for c in e]
        return {tag: (kids if kids else (e.text or ''))}
    return conv(root)


def main():
    sid, skey, bucket = os.environ['COS_SECRET_ID'], os.environ['COS_SECRET_KEY'], os.environ['COS_BUCKET']
    region = os.environ.get('COS_REGION', 'ap-shanghai')
    host = f'{bucket}.cos.{region}.myqcloud.com'
    out = {'bucket_name_hash': hashlib.sha256(bucket.encode()).hexdigest()[:8], 'region': region}
    c, t = get(sid, skey, 'service.cos.myqcloud.com', {})
    out['buckets'] = (c, strip(t))
    for name, p in (('lifecycle', {'lifecycle': ''}), ('versioning', {'versioning': ''}), ('location', {'location': ''}), ('policy', {'policy': ''})):
        c, t = get(sid, skey, host, p)
        out[name] = (c, strip(t) if name != 'policy' else t[:600])
    uploads, marker, ukey = [], '', ''
    while len(uploads) < 5000:
        p = {'uploads': '', 'max-uploads': '1000'}
        if marker:
            p['key-marker'] = marker
        c, t = get(sid, skey, host, p)
        if c != 200:
            out['uploads_error'] = (c, t[:300]); break
        root = ET.fromstring(t); ns = root.tag.split('}')[0] + '}' if root.tag.startswith('{') else ''
        ups = [(u.findtext(f'{ns}Key'), u.findtext(f'{ns}Initiated')) for u in root.findall(f'{ns}Upload')]
        uploads += ups
        if root.findtext(f'{ns}IsTruncated') == 'true' and ups:
            marker = root.findtext(f'{ns}NextKeyMarker') or ups[-1][0]
        else:
            break
    out['incomplete_uploads'] = {'count': len(uploads), 'sample': uploads[:15]}
    print(json.dumps(out, ensure_ascii=False, indent=1))


main()
