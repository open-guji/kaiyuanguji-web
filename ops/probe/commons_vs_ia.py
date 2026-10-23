"""一次性探测（A20，2026-10-23）：Commons 上四庫總目 DjVu 与 IA _tif.zip 是不是同一份像素；thumb 能给多大。只读、不写任何地方。"""
import io, json, subprocess, sys, urllib.parse, urllib.request, zipfile, hashlib, os
from PIL import Image, ImageChops
import numpy as np

UA = 'kaiyuanguji-probe/0.1 (https://github.com/open-guji/kaiyuanguji-web)'
def get(url):
    req = urllib.request.Request(url, headers={'User-Agent': UA})
    with urllib.request.urlopen(req, timeout=600) as r:
        return r.read()

def commons(prefix):
    q = urllib.parse.urlencode({'action': 'query', 'format': 'json', 'formatversion': 2, 'generator': 'allimages',
                                'gaiprefix': prefix, 'gailimit': 5, 'prop': 'imageinfo',
                                'iiprop': 'size|url|sha1|timestamp|comment|metadata', 'iilimit': 20})
    return json.loads(get(f'https://commons.wikimedia.org/w/api.php?{q}'))['query']['pages']

def bilevel_stats(a, b):
    a = np.asarray(a.convert('L'), dtype=np.int16); b = np.asarray(b.convert('L'), dtype=np.int16)
    return {'mean_abs_diff': float(np.abs(a - b).mean()), 'eq_frac': float((np.abs(a - b) < 16).mean())}

out = {}
for ia, leaves in (('06061310.cn', [6, 50]), ('06061302.cn', [6, 105])):
    pages = commons('CADAL' + ia.split('.')[0])
    f = [p for p in pages if p['title'].lower().endswith('.djvu')][0]
    revs = f['imageinfo']
    cur = revs[0]
    meta = {m['name']: m['value'] for m in (cur.get('metadata') or [])}
    rec = {'title': f['title'], 'revisions': [{k: r.get(k) for k in ('timestamp', 'width', 'height', 'size', 'pagecount', 'comment')} for r in revs]}
    djvu = get(cur['url']); rec['djvu_bytes'] = len(djvu)
    open('/tmp/x.djvu', 'wb').write(djvu)
    rec['djvudump_head'] = subprocess.run(['djvudump', '/tmp/x.djvu'], capture_output=True, text=True).stdout[:1500]
    z = zipfile.ZipFile(io.BytesIO(get(f'https://archive.org/download/{ia}/{ia}_tif.zip')))
    rec['ia_leaves'] = len([n for n in z.namelist() if n.endswith('.tif')])
    rec['pages'] = {}
    for leaf in leaves:
        ia_im = Image.open(io.BytesIO(z.read(f'{ia}_tif/{ia}_{leaf:04d}.tif'))); ia_im.load()
        subprocess.run(['ddjvu', '-format=tiff', f'-page={leaf}', '/tmp/x.djvu', '/tmp/p.tif'], check=True)
        dj = Image.open('/tmp/p.tif'); dj.load()
        r = {'ia_size': ia_im.size, 'ia_mode': ia_im.mode, 'ia_dpi': ia_im.info.get('dpi'),
             'djvu_size': dj.size, 'djvu_mode': dj.mode, 'djvu_dpi': dj.info.get('dpi')}
        if dj.size == ia_im.size:
            r['full_res_cmp'] = bilevel_stats(ia_im, dj)
            r['pixel_identical'] = ImageChops.difference(ia_im.convert('L'), dj.convert('L')).getbbox() is None
        else:
            r['full_res_cmp_resized_ia'] = bilevel_stats(ia_im.convert('L').resize(dj.size, Image.LANCZOS), dj)
        thumbs = {}
        base = cur['url'].split('?')[0]; fname = base.rsplit('/', 1)[1]
        tb = base.replace('/wikipedia/commons/', '/wikipedia/commons/thumb/', 1)
        for w in (1280, 1920, 2560, dj.size[0]):
            u = f'{tb}/page{leaf}-{w}px-{fname}.jpg'
            try:
                b = get(u); t = Image.open(io.BytesIO(b))
                thumbs[w] = {'ok': True, 'size': t.size, 'bytes': len(b), 'mode': t.mode,
                             'vs_ia': bilevel_stats(ia_im.convert('L').resize(t.size, Image.LANCZOS), t)}
            except Exception as e:  # noqa: BLE001
                thumbs[w] = {'ok': False, 'err': str(e)[:120]}
        r['thumbs'] = thumbs
        rec['pages'][leaf] = r
    out[ia] = rec
print(json.dumps(out, ensure_ascii=False, indent=1, default=str))
