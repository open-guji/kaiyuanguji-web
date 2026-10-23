#!/usr/bin/env python3
"""核对四庫總目拆页：book-text 的 cord（真源）↔ 裁剪框表 siku-zongmu-splits.json ↔ 线上 IIIF manifest。

cord 重切改了拆页的 FragmentSelector，却没同步裁剪框表／没重出书影，精校页就会拿新框画在旧图上（红框错位）。
这里逐页比：
  1. cord 的 selector（xywh）与原图尺寸 == 裁剪框表里同 canvas 的 xywh、orig_size
  2. cord 的 canvas 宽高 == xywh 的宽高
  3. （--live）线上 manifest 里同 seq 的 canvas 宽高 == cord 的 canvas 宽高
有不一致就逐条列出并以退出码 1 结束。

用法：
  python3 ops/iiif/check_cord_vs_splits.py --cord-dir <book-text>/Book/g/z/k/96mid1ogzk/default --live
  python3 ops/iiif/check_cord_vs_splits.py --vols 04,07          # cord 从 book-text main 取
"""
import argparse
import json
import os
import re
import sys
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
import hosts  # noqa: E402

BOOK_ID = '96mid1ogzk'
CORD_RAW = f'https://raw.githubusercontent.com/open-guji/book-text/main/Book/g/z/k/{BOOK_ID}/default/%s.cord.json'
SPLITS = os.path.join(HERE, 'siku-zongmu-splits.json')


def _selector(canvas):
    src = (canvas or {}).get('source') or {}
    m = re.fullmatch(r'xywh=(\d+),(\d+),(\d+),(\d+)', ((src.get('selector') or {}).get('value')) or '')
    return ([int(x) for x in m.groups()], [src.get('width'), src.get('height')]) if m else (None, None)


def check_volume(vol, cord, splits, manifest=None):
    """vol 形如 '04'。返回问题列表（字符串）。manifest 为线上册 manifest（可 None）。"""
    problems = []
    table = {e['canvas_seq']: e for e in splits if e['vol'] == f'vol{vol}'}
    live = {c['id'].rsplit('/', 1)[1]: (c['width'], c['height']) for c in manifest['items']} if manifest else {}
    for pg in cord.get('pages', []):
        cv = pg.get('canvas')
        if not cv:
            continue
        seq, size = cv['seq'], (cv['width'], cv['height'])
        xywh, orig = _selector(cv)
        tag = f'vol{vol} 第{pg["page"]}页 {seq}'
        if xywh:
            e = table.get(seq)
            if e is None:
                problems.append(f'{tag}：cord 是拆页（{xywh}），裁剪框表里没有这个 canvas')
            else:
                if e['xywh'] != xywh:
                    problems.append(f'{tag}：裁剪框表 xywh {e["xywh"]} ≠ cord {xywh}')
                if orig != [None, None] and e['orig_size'] != orig:
                    problems.append(f'{tag}：裁剪框表 orig_size {e["orig_size"]} ≠ cord {orig}')
            if size != (xywh[2], xywh[3]):
                problems.append(f'{tag}：cord canvas 宽高 {size} ≠ selector 宽高 {tuple(xywh[2:])}')
        elif seq in table:
            problems.append(f'{tag}：裁剪框表有拆页，cord 却没有 selector')
        if live:
            lw = live.get(seq)
            if lw is None:
                problems.append(f'{tag}：线上 manifest 没有这个 canvas')
            elif xywh and lw != size:
                problems.append(f'{tag}：线上 manifest 宽高 {lw} ≠ cord {size}（书影没重出？）')
            elif not xywh and abs(lw[0] * size[1] - lw[1] * size[0]) > 0.01 * lw[1] * size[0]:
                # 整页不拆的页，cord 可能按缩小的图量（如第 1 叶书脊签是一半），只比长宽比
                problems.append(f'{tag}：线上 manifest 长宽比 {lw} 与 cord {size} 对不上')
    return problems


def _load_json(src):
    if src.startswith('http'):
        with urllib.request.urlopen(src, timeout=60) as r:
            return json.load(r)
    with open(src, encoding='utf-8') as f:
        return json.load(f)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--vols', default='all', help='册号，逗号分隔（如 04,07）；all＝cord 目录里有的全部')
    ap.add_argument('--cord-dir', help='本地 cord 目录（NNN.cord.json）；不给就从 book-text main 取')
    ap.add_argument('--live', action='store_true', help='再对照线上 manifest（数据域名）')
    a = ap.parse_args(argv)
    with open(SPLITS, encoding='utf-8') as f:
        splits = json.load(f)
    if a.vols == 'all':
        vols = sorted(set(e['vol'][3:] for e in splits)) if not a.cord_dir else sorted(
            f[:3][1:] for f in os.listdir(a.cord_dir) if f.endswith('.cord.json'))
        vols = [v if len(v) == 2 else v.zfill(2) for v in vols]
    else:
        vols = [v.zfill(2) for v in a.vols.split(',')]
    bad = 0
    for v in vols:
        name = f'0{v}'
        try:
            cord = _load_json(os.path.join(a.cord_dir, f'{name}.cord.json') if a.cord_dir else CORD_RAW % name)
        except Exception as e:  # 该册没有 cord（未入库）就跳过
            print(f'vol{v}：取不到 cord，跳过（{e}）')
            continue
        manifest = _load_json(f'{hosts.DATA_ORIGIN}/iiif/{BOOK_ID}/{v}/manifest.json') if a.live else None
        problems = check_volume(v, cord, splits, manifest)
        bad += len(problems)
        print(f'vol{v}：{"OK" if not problems else str(len(problems)) + " 处不一致"}')
        for p in problems:
            print('  ✗', p)
    return 1 if bad else 0


if __name__ == '__main__':
    sys.exit(main())
