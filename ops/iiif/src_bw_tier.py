#!/usr/bin/env python3
"""按旁车（页面范围）出国内单版整页图：每个不同的源图（src.id）一张 ≤3840 宽 1-bit 无损 WebP，
传到 iiif/<书>/<册>/srcbw/<src_slug>/full/<宽>,/0/default.webp（宽＝书配置 src_w／--width，缺省 3840；路径与 pagemeta.bim_cos 一致）。

用于合扫页的书：史記（988g3f0wsu，文淵閣本 DjVu，src `s1:0243_0007.tif`＝DjVu 第 7 页）、
脉经（99k3i35yww，Commons PDF 内嵌 JP2 对开整页，src `s1:vol01_0004.jp2`＝PDF 第 4 页）。四庫總目仍用 wyg_src_tier.py --bw。
单位阵页（源图＝页图）这里不管，走 pages_bw_tier.py。

源件：页表 sources 里 key 对应的 commons_url（核 sha256）；DjVu 用 ddjvu 解 1-bit 前景，PDF 用 pdfimages 抽 JP2 再灰度＋Otsu 二值。
一册传完就删源件，磁盘只留一册。需要 djvulibre-bin、poppler-utils。

  python3 ops/iiif/src_bw_tier.py --book 988g3f0wsu --vols 01,02 --out /tmp/bw/out --cache /tmp/bw/cache [--upload] [--force]
"""
import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import pages_bw_tier as B  # noqa: E402
import pages_iiif as P  # noqa: E402
import pagemeta  # noqa: E402
import siku_zongmu_iiif as S  # noqa: E402
import wyg_src_tier as W  # noqa: E402
from PIL import Image  # noqa: E402

Image.MAX_IMAGE_PIXELS = None


def needed(meta):
    """旁车 → {src.id: (w, h)}；单位阵页（源图＝页图）不要。"""
    out = {}
    for e in meta['pages'].values():
        if pagemeta._identity(e['H']):
            continue
        out[e['src']['id']] = (int(e['src']['w']), int(e['src']['h']))
    return out


def src_ref(src_id):
    """`s1:0243_0007.tif` → ('s1', '0243', 7)；`s1:vol01_0004.jp2` → ('s1', 'vol01', 4)。"""
    m = re.fullmatch(r'(\w+):(\w+?)_(\d+)\.(tif|jp2)', src_id)
    if not m:
        raise RuntimeError(f'认不出的源图 id：{src_id}')
    return m.group(1), m.group(2), int(m.group(3))


def djvu_to_bw(djvu, page, w, h, dest, width=pagemeta.COS_TIER_W):
    W.djvu_page_to_bw_webp(djvu, page, w, h, dest, width=width)


def pdf_page_to_bw(pdf, page, w, h, dest, tmp, width=pagemeta.COS_TIER_W):
    """PDF 第 page 页的内嵌图（JP2）→ 二值 WebP；内嵌图尺寸须与旁车 src 一致。"""
    os.makedirs(tmp, exist_ok=True)
    pre = os.path.join(tmp, 'img')
    subprocess.run(['pdfimages', '-all', '-f', str(page), '-l', str(page), pdf, pre], check=True)
    files = sorted(f for f in os.listdir(tmp) if f.startswith('img-'))
    if not files:
        raise RuntimeError(f'PDF 第 {page} 页没抽出图')
    # 一页可能有多张图（蒙版等）：取像素最大的一张
    best = max((os.path.join(tmp, f) for f in files), key=lambda p: os.path.getsize(p))
    try:
        with Image.open(best) as im:
            im.load()
            if im.size != (w, h):
                raise RuntimeError(f'PDF 第 {page} 页内嵌图 {im.size} ≠ 旁车 {(w, h)}')
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            B.page_to_bw(im, width).save(dest, 'WEBP', lossless=True, quality=100, method=4)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--book', required=True)
    ap.add_argument('--vols', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--cache', required=True)
    ap.add_argument('--width', type=int, help='整页图宽（缺省取书配置 src_w，再缺省 3840；上限 3840）')
    ap.add_argument('--upload', action='store_true')
    ap.add_argument('--force', action='store_true')
    a = ap.parse_args(argv)

    books = P.load_books()
    if a.book not in books:
        raise SystemExit(f'❌ pages-books.json 里没有 {a.book}')
    S.BOOK_ID = a.book
    width = pagemeta.cos_width(books[a.book], a.width)
    all_vols = sorted(books[a.book]['vols'], key=int)
    by_num = {int(v): v for v in all_vols}
    vols = [by_num[int(x)] for x in (all_vols if a.vols == 'all' else a.vols.split(','))]
    os.makedirs(a.cache, exist_ok=True)
    report = {}
    for v in vols:
        t0 = time.perf_counter()
        table = S.load_page_table(v)
        if table is None or table.get('book_id') != a.book:
            raise SystemExit(f'❌ {a.book}/{v} 没有页表')
        meta = pagemeta.load_pagemeta(table, S.PAGES_BASE, v, S.http_get)
        if meta is None:
            raise SystemExit(f'❌ {a.book}/{v} 页表 r{table["rev"]:03d} 还没有旁车')
        need = needed(meta)
        by_key = {s['key']: s for s in table['sources']}
        local = {}
        n = 0
        for sid, (w, h) in sorted(need.items()):
            key, stem, page = src_ref(sid)
            src = by_key[key]
            if key not in local:
                path = os.path.join(a.cache, os.path.basename(src['commons_url']).split('?')[0])
                if not os.path.exists(path):
                    W.download(src['commons_url'], path, src['sha256'])
                local[key] = path
            dest = os.path.join(a.out, pagemeta.cos_tier_key(a.book, v, pagemeta.src_slug(sid), width))
            if sid.endswith('.jp2'):
                pdf_page_to_bw(local[key], page, w, h, dest, os.path.join(a.cache, 'pdfimg'), width)
            else:
                djvu_to_bw(local[key], page, w, h, dest, width)
            n += 1
        for p in local.values():
            os.remove(p)
        report[v] = {'pages': n, 'seconds': round(time.perf_counter() - t0, 1)}
        print(f'{a.book}/{v}: {report[v]}', flush=True)
        if a.upload:
            r = S.upload_tree(a.out, force=a.force)
            report[v]['upload'] = {k: r[k] for k in ('files', 'uploaded', 'skipped')}
            print(f'  上传：{report[v]["upload"]}', flush=True)
            shutil.rmtree(os.path.join(a.out, 'iiif'), ignore_errors=True)
    print(json.dumps(report, ensure_ascii=False))


if __name__ == '__main__':
    main()
