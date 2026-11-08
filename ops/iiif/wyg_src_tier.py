#!/usr/bin/env python3
"""文淵閣源图档：把 DjVu 整页（左右两个半叶合在一起）转 2400 宽 WebP，传到 iiif/<书>/<册>/src/<slug>/full/2400,/0/default.webp。

用途：书影「显示完整书页」打开时，阅读器按 canvas 的 bim:page.src.url 显示整页源图，字框经 H 换算到源图坐标。
一个 DjVu 页对应两个半叶页，共用一个源图档（slug 取自旁车 src.id，见 pagemeta.src_slug）。

做法（逐册）：读页表与旁车 → 要用到哪些 DjVu 页 → 从页表 sources[0].commons_url 下 DjVu（核 sha256）→
ddjvu 逐页转 PPM → 缩到 2400 宽 → WebP → 传 COS（桶里 ETag 一致就跳过）。一册传完就删 DjVu，磁盘只留一册。

运行环境：需要 djvulibre-bin（ddjvu）；上传用 COS_* 环境变量（同 siku_zongmu_iiif.py）。
"""
import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
import time
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, '..'))

import pagemeta  # noqa: E402
import siku_zongmu_iiif as siku  # noqa: E402
from PIL import Image  # noqa: E402

BOOK_ID = siku.BOOK_ID
UA = 'open-guji-iiif/1.0 (https://open-guji.com; ops@open-guji.com)'


def needed_pages(meta):
    """旁车 → {slug: (DjVu 页号, 源图宽, 源图高)}；单位阵（本身就是源图）的页不要。"""
    out = {}
    for e in meta['pages'].values():
        H = [v for r in e['H'] for v in r]
        if all(abs(a - b) < 1e-9 for a, b in zip(H, [1, 0, 0, 0, 1, 0, 0, 0, 1])):
            continue
        sid = e['src']['id']
        m = re.search(r'#(\d+)$', sid)
        if not m:
            raise RuntimeError(f'源图 id 不带 DjVu 页号：{sid}')
        out[pagemeta.src_slug(sid)] = (int(m.group(1)), int(e['src']['w']), int(e['src']['h']))
    return out


def download(url, dest, sha256, tries=5):
    last = None
    for i in range(tries):
        try:
            h = hashlib.sha256()
            req = urllib.request.Request(url, headers={'User-Agent': UA})
            with urllib.request.urlopen(req, timeout=300) as r, open(dest, 'wb') as fh:
                while True:
                    b = r.read(1 << 20)
                    if not b:
                        break
                    h.update(b)
                    fh.write(b)
            if h.hexdigest() != sha256:
                raise RuntimeError(f'sha256 对不上：{h.hexdigest()} ≠ {sha256}')
            return
        except Exception as e:  # noqa: BLE001 —— 重试几次再报
            last = e
            time.sleep(min(90, 10 * 2 ** i))
    raise last


def djvu_page_to_webp(djvu, page, w, h, out_path, width=pagemeta.SRC_TIER_W, quality=72):
    ppm = out_path + '.ppm'
    subprocess.run(['ddjvu', '-format=pnm', f'-page={page}', djvu, ppm], check=True)
    try:
        with Image.open(ppm) as im:
            im.load()
            if im.size != (w, h):
                raise RuntimeError(f'DjVu 页 {page} 尺寸 {im.size} ≠ 旁车记的 {(w, h)}')
            im = im.convert('RGB')
            im = im.resize((width, max(1, round(h * width / w))), Image.LANCZOS)
            os.makedirs(os.path.dirname(out_path), exist_ok=True)
            im.save(out_path, 'WEBP', quality=quality, method=6)
    finally:
        if os.path.exists(ppm):
            os.remove(ppm)


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument('--vols', required=True, help='册号逗号分隔')
    ap.add_argument('--rev', type=int, required=True, help='页表版本（旁车按 table_sha256 对这一版）')
    ap.add_argument('--out', required=True)
    ap.add_argument('--cache', required=True)
    ap.add_argument('--upload', action='store_true')
    ap.add_argument('--force', action='store_true')
    a = ap.parse_args(argv)

    os.makedirs(a.cache, exist_ok=True)
    report = {}
    for v in a.vols.split(','):
        vd = siku.vol_dir(int(v))
        table = siku.load_page_table(int(v), rev=a.rev)
        if table is None:
            raise SystemExit(f'vol{vd} 没有页表 r{a.rev:03d}')
        meta = pagemeta.load_pagemeta(table, siku.PAGES_BASE, vd, siku.http_get)
        if meta is None:
            raise SystemExit(f'vol{vd} 没有旁车')
        need = needed_pages(meta)
        src = table['sources'][0]
        if len(table['sources']) != 1 or not src.get('commons_url'):
            raise SystemExit(f'vol{vd} 源件不是单个 Commons DjVu：{table["sources"]}')
        djvu = os.path.join(a.cache, os.path.basename(src['r2']))
        t0 = time.perf_counter()
        download(src['commons_url'], djvu, src['sha256'])
        for slug, (page, w, h) in sorted(need.items()):
            key = pagemeta.src_tier_key(BOOK_ID, vd, slug)
            djvu_page_to_webp(djvu, page, w, h, os.path.join(a.out, key))
        os.remove(djvu)
        report[vd] = {'pages': len(need), 'seconds': round(time.perf_counter() - t0, 1)}
        print(f'vol{vd}: {len(need)} 个源图档（{report[vd]["seconds"]}s）', flush=True)
        if a.upload:
            r = siku.upload_tree(a.out, force=a.force)
            report[vd]['upload'] = {k: r[k] for k in ('files', 'uploaded', 'skipped')}
            print(f'  上传：{report[vd]["upload"]}', flush=True)
            subprocess.run(['rm', '-rf', os.path.join(a.out, 'iiif')], check=True)
    print(json.dumps(report, ensure_ascii=False))


if __name__ == '__main__':
    main()
