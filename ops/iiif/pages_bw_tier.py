#!/usr/bin/env python3
"""单页扫描书（全唐文、北行日錄…，源图＝页图）的国内单版整页：页图 → 1-bit 无损 WebP（≤3840 宽）→ COS `iiif/<书>/<册>/srcbw/p<seq>/full/3840,/0/default.webp`。

与四庫總目的 wyg_src_tier.py --bw 同一规格（见 pagemeta.cos_tier_key／bim_cos_page）。页图本身已是黑白（cv 管线 RGB PNG 只有 0／255）就直接用，
否则灰度后 Otsu 二值。页图比 3840 宽才缩，缩小时先灰度 LANCZOS 再按阈值二值（偏深一点，细笔画不丢）。
用法：
  python3 ops/iiif/pages_bw_tier.py --book 995ejelvk0 --vols 005 --out /tmp/bw --cache /tmp/cache [--upload] [--force]
"""
import argparse
import json
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import pages_iiif as P  # noqa: E402
import pagemeta  # noqa: E402
import siku_zongmu_iiif as S  # noqa: E402
from PIL import Image  # noqa: E402


def otsu(gray):
    hist = gray.histogram()[:256]
    total = sum(hist)
    sum_all = sum(i * h for i, h in enumerate(hist))
    wb = sb = 0
    best, thr = -1.0, 128
    for t in range(256):
        wb += hist[t]
        if not wb:
            continue
        wf = total - wb
        if not wf:
            break
        sb += t * hist[t]
        mb, mf = sb / wb, (sum_all - sb) / wf
        var = wb * wf * (mb - mf) ** 2
        if var > best:
            best, thr = var, t
    return thr + 1


def page_to_bw(im, width=pagemeta.COS_TIER_W):
    """页图 → 黑白两色的 L 图（≤width 宽）。"""
    g = im.convert('L')
    colors = g.getcolors(256) or []
    bilevel = bool(colors) and all(v in (0, 255) for _, v in colors)
    thr = 128 if bilevel else otsu(g)
    if g.width > width:
        g = g.resize((width, round(g.height * width / g.width)), Image.LANCZOS)
        thr = min(thr, 160) if bilevel else thr
    return g.point(lambda v: 0 if v < thr else 255)


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
    if a.book not in books or a.book == '96mid1ogzk':
        raise SystemExit(f'❌ {a.book} 不是 pages-books.json 里的单页扫描书')
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
        plan = [{'seq': p['seq'], 'sha256': p['sha256']} for p in table['pages']]
        S.fetch_pages(plan, a.cache)
        nbytes = 0
        for p in table['pages']:
            key = pagemeta.cos_tier_key(a.book, v, pagemeta.page_slug(p['seq']), width)
            dest = os.path.join(a.out, key)
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            with Image.open(S.page_path(a.cache, p['sha256'])) as im:
                im.load()
                if p.get('w') and (im.width, im.height) != (p['w'], p['h']):
                    raise SystemExit(f'❌ {a.book}/{v} {p["seq"]} 页图尺寸 {im.size} ≠ 页表 {(p["w"], p["h"])}')
                page_to_bw(im, width).save(dest, 'WEBP', lossless=True, quality=100, method=4)
            nbytes += os.path.getsize(dest)
        report[v] = {'pages': len(table['pages']), 'mb': round(nbytes / 1e6, 1), 'seconds': round(time.perf_counter() - t0, 1)}
        print(f'{a.book}/{v}: {report[v]}', flush=True)
        if a.upload:
            r = S.upload_tree(a.out, force=a.force)
            report[v]['upload'] = {k: r[k] for k in ('files', 'uploaded', 'skipped')}
            print(f'  上传：{report[v]["upload"]}', flush=True)
            import shutil
            shutil.rmtree(os.path.join(a.out, 'iiif'), ignore_errors=True)
    print(json.dumps(report, ensure_ascii=False))


if __name__ == '__main__':
    main()
