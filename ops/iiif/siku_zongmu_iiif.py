#!/usr/bin/env python3
"""四庫總目（武英殿本）书影：切三档 WebP → 生成 IIIF Presentation 3 manifest → 上传 COS `iiif/` 前缀（overview#388）。

方案：overview `项目进展/古籍索引网站/进度/四库总目影像存储方案.md`（#355）；IIIF 约定见 #357。

- 源：IA 上浙大 CADAL 扫描的武英殿本，每册一个 identifier（siku-zongmu-volumes.tsv，第 N 行＝第 N 册），
  下整册 `_tif.zip`（每册 5–20 MB）。
- 三档（方案 §1.3「黑白专用」，按源图模式分流）：
    1-bit：缩略 300 px WebP q75 有损；阅读 1200 px 先量化成 4 级灰再 WebP 无损；放大＝原图 1-bit WebP 无损（与原图逐像素一致）
    其它：缩略 300 px、阅读 1200 px、放大 ≤2400 px，一律 WebP q75（29 卡的做法）
- 路径（#357）：canvas id  https://data.kaiyuanguji.com/iiif/<bookId>/canvas/<册2位>/<页序>
                图        iiif/<bookId>/<册>/<页序>/full/<宽>,/0/default.webp（level 0 静态，另有 info.json）
                册 manifest iiif/<bookId>/<册>/manifest.json；书级 Collection iiif/<bookId>/manifest.json
  页序＝IA leaf 号补零 4 位；合扫拆页按整理总管的裁剪框表（siku-zongmu-splits.json，overview 73d3b4be）
  拆成 a–d 四个 canvas，原合扫叶本身不出 canvas。
- canvas body 用 Choice：本站 → Commons thumb（1280 px）→ IA IIIF（1200 px）。拆页 canvas 没有 Commons
  （thumb 不能裁），Commons 当前版本页数与 IA 叶数不等时（#125 换了拆页版）整册不挂 Commons。

用法：
  python3 ops/iiif/siku_zongmu_iiif.py --vols 02,03 --out /tmp/iiif               # 只切片＋生成 manifest
  python3 ops/iiif/siku_zongmu_iiif.py --vols 03 --leaves 10,105 --out /tmp/iiif  # 本地试几页
  … --upload    上传（要 COS_SECRET_ID／COS_SECRET_KEY／COS_BUCKET，COS_REGION 默认 ap-shanghai）
  … --verify    上传后从 data.kaiyuanguji.com 逐个取回核对
只依赖 Pillow；COS 签名用标准库实现（cos-python-sdk 的 crcmod 在部分环境装不上）。
"""
import argparse
import concurrent.futures as cf
import hashlib
import hmac
import io
import json
import os
import random
import statistics
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile

from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
BOOK_ID = '96mid1ogzk'  # 欽定四庫全書總目 武英殿刻本（guji-workspace 同名目录、F1 样张同一个 id）
PUBLIC_BASE = 'https://data.kaiyuanguji.com'
KEY_PREFIX = 'iiif'
UA = 'kaiyuanguji-iiif/0.1 (https://www.kaiyuanguji.com; open-guji)'

THUMB_W, READ_W, ZOOM_MAX_W_GRAY = 300, 1200, 2400
COMMONS_W, IA_W = 1280, 1200

# 图按内容不常变（重切才变），缓存 30 天；manifest 会随回退源调整，5 分钟
IMAGE_CACHE = 'public, max-age=2592000'
JSON_CACHE = 'public, max-age=300'


# ─── 册与页序 ───

def load_volumes(path=os.path.join(HERE, 'siku-zongmu-volumes.tsv')):
    """{册号(int): {'ia': '06061301.cn', 'leaves': 188, 'juan': '卷一~卷三'}}；第 N 行数据＝第 N 册。"""
    vols = {}
    with open(path, encoding='utf-8') as f:
        rows = [l.rstrip('\n').split('\t') for l in f if l.strip()]
    for i, r in enumerate(rows[1:], start=1):
        vols[i] = {'ia': r[0], 'leaves': int(r[1]), 'juan': r[3]}
    return vols


def load_splits(path=os.path.join(HERE, 'siku-zongmu-splits.json')):
    """{册号: {leaf: [ {seq, xywh, orig_size, pos}, … 按 a–d ]}}"""
    out = {}
    with open(path, encoding='utf-8') as f:
        for r in json.load(f):
            vol = int(r['vol'].replace('vol', ''))
            out.setdefault(vol, {}).setdefault(r['ia_leaf'], []).append(
                {'seq': r['canvas_seq'], 'xywh': r['xywh'], 'orig_size': r['orig_size'], 'pos': r['pos']})
    for leaves in out.values():
        for parts in leaves.values():
            parts.sort(key=lambda p: p['seq'])
    return out


def plan_canvases(vol, leaf_count, splits):
    """该册按阅读顺序的 canvas 表：[{seq, leaf, xywh|None, pos|None}]。合扫叶只出拆开的块。"""
    vs = splits.get(vol, {})
    out = []
    for leaf in range(1, leaf_count + 1):
        if leaf in vs:
            out += [{'seq': p['seq'], 'leaf': leaf, 'xywh': p['xywh'], 'pos': p['pos']} for p in vs[leaf]]
        else:
            out.append({'seq': f'{leaf:04d}', 'leaf': leaf, 'xywh': None, 'pos': None})
    return out


def vol_dir(vol):
    return f'{vol:02d}'


def image_base_key(vol, seq):
    return f'{KEY_PREFIX}/{BOOK_ID}/{vol_dir(vol)}/{seq}'


def tier_key(vol, seq, width):
    return f'{image_base_key(vol, seq)}/full/{width},/0/default.webp'


def canvas_id(vol, seq):
    return f'{PUBLIC_BASE}/{KEY_PREFIX}/{BOOK_ID}/canvas/{vol_dir(vol)}/{seq}'


def manifest_key(vol):
    return f'{KEY_PREFIX}/{BOOK_ID}/{vol_dir(vol)}/manifest.json'


def collection_key():
    return f'{KEY_PREFIX}/{BOOK_ID}/manifest.json'


def public_url(key):
    return f'{PUBLIC_BASE}/{key}'


# ─── 取源图 ───

def http_get(url, timeout=120, tries=4, headers=None):
    last = None
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers={'User-Agent': UA, **(headers or {})})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.read(), dict(r.headers)
        except urllib.error.HTTPError as e:
            last = e
            if e.code not in (429, 500, 502, 503, 504):
                raise
        except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
            last = e
        time.sleep(min(60, 5 * 2 ** i))
    raise last


def fetch_tif_zip(ia_id, cache_dir):
    path = os.path.join(cache_dir, f'{ia_id}_tif.zip')
    if not os.path.exists(path):
        body, _ = http_get(f'https://archive.org/download/{ia_id}/{ia_id}_tif.zip', timeout=600)
        tmp = path + '.part'
        with open(tmp, 'wb') as f:
            f.write(body)
        os.replace(tmp, path)
    return path


def leaf_name(ia_id, leaf):
    return f'{ia_id}_tif/{ia_id}_{leaf:04d}.tif'


# ─── 切三档 ───

def _webp(im, **kw):
    b = io.BytesIO()
    im.save(b, 'WEBP', method=6, **kw)
    return b.getvalue()


def _resize_w(im, w):
    W, H = im.size
    if w >= W:
        return im
    return im.resize((w, max(1, round(H * w / W))), Image.LANCZOS)


def quantize_levels(g, levels=4):
    step = 255 / (levels - 1)
    lut = [round(round(x / step) * step) for x in range(256)]
    return g.point(lut)


def encode_tiers(im):
    """返回 [(档名, 宽, 高, webp bytes)]，按 缩略、阅读、放大。"""
    W, H = im.size
    out = []
    if im.mode == '1':
        g = im.convert('L')
        t = _resize_w(g, THUMB_W)
        out.append(('thumb', *t.size, _webp(t, quality=75)))
        r = quantize_levels(_resize_w(g, READ_W), 4)
        out.append(('read', *r.size, _webp(r, lossless=True)))
        out.append(('zoom', W, H, _webp(im.convert('L'), lossless=True)))
    else:
        base = im.convert('RGB') if im.mode not in ('L', 'RGB') else im
        for name, w in (('thumb', THUMB_W), ('read', READ_W), ('zoom', ZOOM_MAX_W_GRAY)):
            t = _resize_w(base, w)
            out.append((name, *t.size, _webp(t, quality=75)))
    return out


def info_json(vol, seq, w, h, tiers):
    return {
        '@context': 'http://iiif.io/api/image/3/context.json',
        'id': public_url(image_base_key(vol, seq)),
        'type': 'ImageService3',
        'protocol': 'http://iiif.io/api/image',
        'profile': 'level0',
        'width': w, 'height': h,
        'sizes': [{'width': tw, 'height': th} for _, tw, th, _ in tiers],
        'preferredFormats': ['webp'],
        'extraFormats': ['webp'],
    }


def _slice_one(args):
    """进程池里跑：切一个 canvas 的三档并写盘，返回该 canvas 的记录。"""
    vol, ia, zpath, c, out_dir = args
    with zipfile.ZipFile(zpath) as z:
        src = Image.open(io.BytesIO(z.read(leaf_name(ia, c['leaf']))))
        src.load()
    if c['xywh']:
        x, y, w, h = c['xywh']
        if x + w > src.size[0] or y + h > src.size[1]:
            raise RuntimeError(f'vol{vol:02d} {c["seq"]} 裁剪框 {c["xywh"]} 超出原图 {src.size}')
        im = src.crop((x, y, x + w, y + h))
    else:
        im = src
    t0 = time.perf_counter()
    tiers = encode_tiers(im)
    dt = time.perf_counter() - t0
    W, H = im.size
    for _, tw, _, data in tiers:
        p = os.path.join(out_dir, tier_key(vol, c['seq'], tw))
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, 'wb') as f:
            f.write(data)
    with open(os.path.join(out_dir, image_base_key(vol, c['seq']), 'info.json'), 'w', encoding='utf-8') as f:
        json.dump(info_json(vol, c['seq'], W, H, tiers), f, ensure_ascii=False)
    return {**c, 'width': W, 'height': H, 'mode': src.mode, 'encode_s': dt,
            'tiers': [(n, tw, th, len(d)) for n, tw, th, d in tiers]}


def slice_volume(vol, meta, splits, out_dir, cache_dir, leaves=None, jobs=None):
    """切一册，写到 out_dir/<key>；返回 {canvases:[…], stats:{…}}。"""
    ia = meta['ia']
    zpath = fetch_tif_zip(ia, cache_dir)
    plan = plan_canvases(vol, meta['leaves'], splits)
    if leaves:
        plan = [c for c in plan if c['leaf'] in leaves]
    with zipfile.ZipFile(zpath) as z:
        names = set(z.namelist())
    missing = [leaf_name(ia, c['leaf']) for c in plan if leaf_name(ia, c['leaf']) not in names]
    if missing:
        raise SystemExit(f'❌ {ia} 缺 {len(missing)} 张：{missing[:3]}（zip 里 {len(names)} 项）')
    with cf.ProcessPoolExecutor(jobs or os.cpu_count()) as ex:
        canvases = list(ex.map(_slice_one, [(vol, ia, zpath, c, out_dir) for c in plan], chunksize=4))
    sizes = {name: [t[3] for c in canvases for t in c['tiers'] if t[0] == name] for name in ('thumb', 'read', 'zoom')}
    t_enc = [c.pop('encode_s') for c in canvases]
    n = len(canvases)
    per_page = [sum(t[3] for t in c['tiers']) for c in canvases]
    stats = {
        'canvases': n,
        'modes': sorted({c['mode'] for c in canvases}),
        'bytes_total': sum(per_page),
        'mean_kb': {k: round(statistics.mean(v) / 1000, 1) for k, v in sizes.items() if v},
        'mean_page_kb': round(statistics.mean(per_page) / 1000, 1) if n else 0,
        'encode_s_total': round(sum(t_enc), 1),
        'encode_s_per_page': round(statistics.mean(t_enc), 2) if n else 0,
    }
    return {'canvases': canvases, 'stats': stats}


# ─── Commons ───

def commons_file(ia_id):
    """Commons 上该册 DjVu：{'name', 'url', 'pagecount'}；查不到／限流返回 None（manifest 照出，只是不挂 Commons）。"""
    prefix = 'CADAL' + ia_id.split('.')[0]
    q = urllib.parse.urlencode({
        'action': 'query', 'format': 'json', 'formatversion': 2,
        'generator': 'allimages', 'gaiprefix': prefix, 'gailimit': 20,
        'prop': 'imageinfo', 'iiprop': 'size|url',
    })
    try:
        body, _ = http_get(f'https://commons.wikimedia.org/w/api.php?{q}', timeout=60, tries=4)
    except Exception as e:  # noqa: BLE001
        print(f'  ⚠ Commons 查询失败（{e}），本册不挂 Commons', file=sys.stderr)
        return None
    pages = json.loads(body).get('query', {}).get('pages', [])
    hits = [p for p in pages if '總目' in p['title'] and p['title'].lower().endswith('.djvu')]
    if len(hits) != 1:
        print(f'  ⚠ Commons 前缀 {prefix} 找到 {len(hits)} 个 DjVu，本册不挂 Commons', file=sys.stderr)
        return None
    ii = hits[0]['imageinfo'][0]
    return {'name': hits[0]['title'].split(':', 1)[1], 'url': ii['url'], 'pagecount': ii.get('pagecount')}


def commons_thumb(cf_, page):
    fname = cf_['url'].rsplit('/', 1)[1]
    return cf_['url'].replace('/wikipedia/commons/', '/wikipedia/commons/thumb/', 1) + f'/page{page}-{COMMONS_W}px-{fname}.jpg'


# ─── manifest ───

def ia_image_id(ia_id, leaf):
    path = urllib.parse.quote(f'{ia_id}/{ia_id}_tif.zip/{leaf_name(ia_id, leaf)}', safe='')
    return f'https://iiif.archive.org/image/iiif/3/{path}'


def build_canvas(vol, meta, c, commons):
    cid = canvas_id(vol, c['seq'])
    W, H = c['width'], c['height']
    by = {n: (tw, th) for n, tw, th, _ in c['tiers']}
    rw, rh = by['read']
    svc = [{'id': public_url(image_base_key(vol, c['seq'])), 'type': 'ImageService3', 'profile': 'level0'}]
    items = [{
        'id': public_url(tier_key(vol, c['seq'], rw)), 'type': 'Image', 'format': 'image/webp',
        'width': rw, 'height': rh, 'label': {'zh': ['本站']}, 'service': svc,
    }]
    if commons and not c['xywh']:
        items.append({
            'id': commons_thumb(commons, c['leaf']), 'type': 'Image', 'format': 'image/jpeg',
            'width': COMMONS_W, 'height': round(COMMONS_W * H / W), 'label': {'zh': ['维基共享资源']},
        })
    region = 'full' if not c['xywh'] else ','.join(map(str, c['xywh']))
    ia_img = ia_image_id(meta['ia'], c['leaf'])
    items.append({
        'id': f'{ia_img}/{region}/{IA_W},/0/default.jpg', 'type': 'Image', 'format': 'image/jpeg',
        'width': IA_W, 'height': round(IA_W * H / W), 'label': {'zh': ['Internet Archive']},
        'service': [{'id': ia_img, 'type': 'ImageService3', 'profile': 'level2'}],
    })
    tw, th = by['thumb']
    label = f'第 {c["leaf"]} 葉' + (f'（{c["pos"]}）' if c['pos'] else '')
    canvas = {
        'id': cid, 'type': 'Canvas', 'label': {'zh': [label]}, 'width': W, 'height': H,
        'thumbnail': [{'id': public_url(tier_key(vol, c['seq'], tw)), 'type': 'Image',
                       'format': 'image/webp', 'width': tw, 'height': th}],
        'items': [{
            'id': f'{cid}/page', 'type': 'AnnotationPage',
            'items': [{
                'id': f'{cid}/page/image', 'type': 'Annotation', 'motivation': 'painting',
                'target': cid, 'body': {'type': 'Choice', 'items': items},
            }],
        }],
    }
    if c['xywh']:
        # #357：拆开的块记原图与裁剪框，坐标原点＝裁剪区左上角
        canvas['source'] = {'id': ia_img, 'type': 'Image',
                            'selector': {'type': 'FragmentSelector', 'value': 'xywh=' + ','.join(map(str, c['xywh']))}}
    return canvas


def usable_commons(vol, meta, commons):
    if commons and commons.get('pagecount') != meta['leaves']:
        print(f'  ⚠ vol{vol:02d} Commons 页数 {commons.get("pagecount")} ≠ IA 叶数 {meta["leaves"]}（已换拆页版？），本册不挂 Commons',
              file=sys.stderr)
        return None
    return commons


def build_manifest(vol, meta, canvases, commons):
    mid = public_url(manifest_key(vol))
    return {
        '@context': 'http://iiif.io/api/presentation/3/context.json',
        'id': mid, 'type': 'Manifest',
        'label': {'zh': [f'欽定四庫全書總目（武英殿本）第 {vol} 冊 {meta["juan"]}']},
        'metadata': [
            {'label': {'zh': ['卷次']}, 'value': {'zh': [meta['juan']]}},
            {'label': {'zh': ['冊']}, 'value': {'zh': [f'{vol} / 99']}},
            {'label': {'zh': ['影像來源']}, 'value': {'zh': [f'浙江大學圖書館藏、CADAL 掃描，Internet Archive {meta["ia"]}']}},
        ],
        'rights': 'http://creativecommons.org/publicdomain/mark/1.0/',
        'requiredStatement': {'label': {'zh': ['影像來源']},
                              'value': {'zh': ['CADAL（浙江大學）掃描，經 Internet Archive 公開；開源古籍切片']}},
        'viewingDirection': 'right-to-left',
        'homepage': [{'id': f'https://archive.org/details/{meta["ia"]}', 'type': 'Text',
                      'label': {'zh': ['Internet Archive 原條目']}, 'format': 'text/html'}],
        'partOf': [{'id': public_url(collection_key()), 'type': 'Collection'}],
        'items': [build_canvas(vol, meta, c, commons) for c in canvases],
    }


def build_collection(vols_meta, vols_present):
    return {
        '@context': 'http://iiif.io/api/presentation/3/context.json',
        'id': public_url(collection_key()), 'type': 'Collection',
        'label': {'zh': ['欽定四庫全書總目（武英殿本）']},
        'rights': 'http://creativecommons.org/publicdomain/mark/1.0/',
        'viewingDirection': 'right-to-left',
        'items': [{'id': public_url(manifest_key(v)), 'type': 'Manifest',
                   'label': {'zh': [f'第 {v} 冊 {vols_meta[v]["juan"]}']}} for v in sorted(vols_present)],
    }


def existing_volumes(vols_meta):
    """线上已有 manifest 的册（书级 Collection 要列全，不只列本次跑的）。"""
    def probe(v):
        try:
            http_get(public_url(manifest_key(v)) + f'?t={int(time.time())}', timeout=30, tries=2)
            return v
        except Exception:  # noqa: BLE001
            return None
    with cf.ThreadPoolExecutor(16) as ex:
        return {v for v in ex.map(probe, vols_meta) if v}


# ─── COS 上传（XML API，签名按腾讯云「请求签名」文档，标准库实现）───

def cos_authorization(secret_id, secret_key, method, path, headers, now=None, ttl=900):
    start = int(now if now is not None else time.time()) - 60
    key_time = f'{start};{start + ttl + 60}'
    sign_key = hmac.new(secret_key.encode(), key_time.encode(), hashlib.sha1).hexdigest()
    hs = sorted((urllib.parse.quote(k.lower(), safe='-_.~'), urllib.parse.quote(str(v), safe='-_.~'))
                for k, v in headers.items())
    http_string = f'{method.lower()}\n{path}\n\n' + '&'.join(f'{k}={v}' for k, v in hs) + '\n'
    sts = f'sha1\n{key_time}\n{hashlib.sha1(http_string.encode()).hexdigest()}\n'
    sig = hmac.new(sign_key.encode(), sts.encode(), hashlib.sha1).hexdigest()
    return (f'q-sign-algorithm=sha1&q-ak={secret_id}&q-sign-time={key_time}&q-key-time={key_time}'
            f'&q-header-list={";".join(k for k, _ in hs)}&q-url-param-list=&q-signature={sig}')


class Cos:
    def __init__(self):
        self.sid = os.environ['COS_SECRET_ID']
        self.skey = os.environ['COS_SECRET_KEY']
        self.bucket = os.environ['COS_BUCKET']
        self.region = os.environ.get('COS_REGION', 'ap-shanghai')
        self.host = f'{self.bucket}.cos.{self.region}.myqcloud.com'

    def put(self, key, body, content_type, cache_control, tries=5):
        path, last = '/' + key, None
        for i in range(tries):
            headers = {'Host': self.host, 'Content-Type': content_type, 'Cache-Control': cache_control,
                       'Content-Length': str(len(body))}
            # 与 cos-nodejs-sdk-v5 一样只签 Host
            headers['Authorization'] = cos_authorization(self.sid, self.skey, 'PUT', path, {'Host': self.host})
            req = urllib.request.Request(f'https://{self.host}{urllib.parse.quote(path, safe="/,")}',
                                         data=body, method='PUT', headers=headers)
            try:
                with urllib.request.urlopen(req, timeout=120) as r:
                    r.read()
                    return
            except urllib.error.HTTPError as e:
                msg = e.read()[:300].decode('utf-8', 'replace')
                last = RuntimeError(f'PUT {key} → {e.code} {msg}')
                # 5xx、限流、签名过期（deploy.yml 10-05 遇到过）重试，其它 4xx 直接报
                if not (e.code >= 500 or e.code in (408, 429) or 'Signature' in msg or 'RequestTimeTooSkewed' in msg):
                    raise last from None
            except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
                last = e
            time.sleep(0.5 * 2 ** i)
        raise last


def walk_files(root):
    for d, _, fs in os.walk(root):
        for f in fs:
            full = os.path.join(d, f)
            yield full, os.path.relpath(full, root).replace(os.sep, '/')


def upload_tree(root, keys_first_last=('manifest.json',), workers=16):
    """先传图和 info.json，最后传 manifest／Collection（manifest 上线时图已经都在）。"""
    cos = Cos()
    files = list(walk_files(root))
    late = [f for f in files if f[1].endswith(keys_first_last)]
    early = [f for f in files if f not in late]

    def put(item):
        full, key = item
        with open(full, 'rb') as fh:
            body = fh.read()
        if key.endswith('.webp'):
            cos.put(key, body, 'image/webp', IMAGE_CACHE)
        else:
            cos.put(key, body, 'application/json; charset=utf-8', JSON_CACHE)
        return len(body)

    t0, total = time.perf_counter(), 0
    for batch in (early, late):
        with cf.ThreadPoolExecutor(workers) as ex:
            for n in ex.map(put, batch):
                total += n
    return {'files': len(files), 'bytes': total, 'seconds': round(time.perf_counter() - t0, 1)}


# ─── 线上核对 ───

def verify_online(root, workers=16):
    """逐个从 data.kaiyuanguji.com 取回本次生成的每个文件，比对字节。"""
    files = list(walk_files(root))
    bad = []

    def check(item):
        full, key = item
        with open(full, 'rb') as fh:
            want = fh.read()
        try:
            got, hdr = http_get(public_url(key), timeout=60, tries=3)
        except Exception as e:  # noqa: BLE001
            return key, f'取不到：{e}'
        if got != want:
            return key, f'内容不一致（线上 {len(got)} B，本地 {len(want)} B）'
        ct = hdr.get('Content-Type', '')
        if key.endswith('.webp') and ct != 'image/webp':
            return key, f'Content-Type={ct}'
        return None

    t0 = time.perf_counter()
    with cf.ThreadPoolExecutor(workers) as ex:
        for r in ex.map(check, files):
            if r:
                bad.append(r)
    return {'checked': len(files), 'bad': bad, 'seconds': round(time.perf_counter() - t0, 1)}


def sample_sheet(out_dir, report, n=20, seed=388):
    """抽 n 页阅读档复制到 out_dir/../samples，供人眼看（workflow 作为工件上传）。"""
    rnd = random.Random(seed)
    pool = [(v, c['seq'], dict((t[0], t[1]) for t in c['tiers'])['read'])
            for v, r in report['volumes'].items() for c in r['canvases']]
    pick = sorted(rnd.sample(pool, min(n, len(pool))))
    dest = os.path.join(os.path.dirname(os.path.abspath(out_dir)), 'samples')
    os.makedirs(dest, exist_ok=True)
    for v, seq, w in pick:
        src = os.path.join(out_dir, tier_key(int(v), seq, w))
        with open(src, 'rb') as a, open(os.path.join(dest, f'vol{int(v):02d}-{seq}-read.webp'), 'wb') as b:
            b.write(a.read())
    return [f'vol{int(v):02d}/{seq}' for v, seq, _ in pick]


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--vols', required=True, help='册号，逗号分隔，如 02,03；all＝全部 99 册')
    ap.add_argument('--leaves', help='只切这些 IA leaf（本地试跑用，逗号分隔）；给了就不传 Collection')
    ap.add_argument('--out', required=True, help='输出目录（其下按 COS key 布局）')
    ap.add_argument('--cache', default=None, help='tif zip 缓存目录（默认 <out>/../cache）')
    ap.add_argument('--jobs', type=int, default=None, help='切片进程数（默认 CPU 核数）')
    ap.add_argument('--no-commons', action='store_true', help='不查 Commons、不挂 Commons 回退')
    ap.add_argument('--upload', action='store_true')
    ap.add_argument('--verify', action='store_true')
    ap.add_argument('--report', help='把报告 JSON 写到这里')
    a = ap.parse_args(argv)

    vols_meta = load_volumes()
    splits = load_splits()
    vols = sorted(vols_meta) if a.vols == 'all' else [int(v) for v in a.vols.split(',') if v.strip()]
    for v in vols:
        if v not in vols_meta:
            raise SystemExit(f'❌ 没有第 {v} 册（共 {len(vols_meta)} 册）')
    leaves = {int(x) for x in a.leaves.split(',')} if a.leaves else None
    out = os.path.abspath(a.out)
    cache = os.path.abspath(a.cache or os.path.join(os.path.dirname(out), 'cache'))
    os.makedirs(out, exist_ok=True)
    os.makedirs(cache, exist_ok=True)

    report = {'book': BOOK_ID, 'volumes': {}}
    for v in vols:
        meta = vols_meta[v]
        t0 = time.perf_counter()
        print(f'vol{v:02d} {meta["ia"]}（{meta["leaves"]} 叶，{meta["juan"]}）…', flush=True)
        r = slice_volume(v, meta, splits, out, cache, leaves, a.jobs)
        r['stats']['wall_s'] = round(time.perf_counter() - t0, 1)
        commons = None if a.no_commons else usable_commons(v, meta, commons_file(meta['ia']))
        man = build_manifest(v, meta, r['canvases'], commons)
        r['stats']['commons'] = commons['name'] if commons else None
        p = os.path.join(out, manifest_key(v))
        with open(p, 'w', encoding='utf-8') as f:
            json.dump(man, f, ensure_ascii=False, separators=(',', ':'))
        report['volumes'][f'{v:02d}'] = r
        print('  ' + json.dumps(r['stats'], ensure_ascii=False), flush=True)

    if not leaves:
        present = set(vols)
        if a.upload:
            present |= existing_volumes(vols_meta)
        with open(os.path.join(out, collection_key()), 'w', encoding='utf-8') as f:
            json.dump(build_collection(vols_meta, present), f, ensure_ascii=False, separators=(',', ':'))

    report['samples'] = sample_sheet(out, report)
    if a.upload:
        report['upload'] = upload_tree(out)
        print('上传：' + json.dumps(report['upload'], ensure_ascii=False), flush=True)
    if a.verify:
        report['verify'] = verify_online(out)
        v = report['verify']
        print(f'核对：{v["checked"]} 个文件，{len(v["bad"])} 个不对', flush=True)
        for key, why in v['bad'][:50]:
            print(f'  ✗ {key}：{why}')
    if a.report:
        slim = {**report, 'volumes': {k: {'stats': r['stats'], 'canvases': [c['seq'] for c in r['canvases']]}
                                      for k, r in report['volumes'].items()}}
        with open(a.report, 'w', encoding='utf-8') as f:
            json.dump(slim, f, ensure_ascii=False, indent=1)
    summary = os.environ.get('GITHUB_STEP_SUMMARY')
    if summary:
        with open(summary, 'a', encoding='utf-8') as f:
            f.write(markdown_summary(report))
    if a.verify and report['verify']['bad']:
        sys.exit(1)


def markdown_summary(report):
    lines = ['## 四庫總目 IIIF 切片', '',
             '| 册 | canvas | 缩略 KB | 阅读 KB | 放大 KB | 三档均值 KB | 合计 MB | 编码 s/页 | 本册用时 s | Commons |',
             '|---|---|---|---|---|---|---|---|---|---|']
    for v, r in report['volumes'].items():
        st = r['stats']
        mk = st['mean_kb']
        lines.append(f"| {v} | {st['canvases']} | {mk.get('thumb')} | {mk.get('read')} | {mk.get('zoom')} | "
                     f"{st['mean_page_kb']} | {st['bytes_total'] / 1e6:.1f} | {st['encode_s_per_page']} | "
                     f"{st['wall_s']} | {st['commons'] or '—'} |")
    if 'upload' in report:
        u = report['upload']
        lines += ['', f"上传：{u['files']} 个文件，{u['bytes'] / 1e6:.1f} MB，{u['seconds']} s"]
    if 'verify' in report:
        v = report['verify']
        lines += ['', f"线上核对：{v['checked']} 个文件，{len(v['bad'])} 个不对（{v['seconds']} s）"]
        lines += [f'- ✗ `{k}`：{why}' for k, why in v['bad'][:30]]
    lines += ['', '抽看 20 页（阅读档在工件 samples/）：' + '、'.join(report.get('samples', [])), '']
    return '\n'.join(lines)


if __name__ == '__main__':
    main()
