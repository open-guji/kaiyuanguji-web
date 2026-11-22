#!/usr/bin/env python3
"""把「半叶编号」的线上 IIIF manifest 改成页序编号（canvas seq ＝ cord page 四位补零），图片对象不动。

背景与方案：docs/iiif-canvas-seq-unify.md（方案 A：只重发 manifest）。史記、脉经的 manifest 用 IA／源图叶号加半叶后缀
（0006a、0006c…）做 canvas 编号，对读数据（cord.json）用页序（0001…），两边对不上，书影加载不出来。

做法：取线上现有 manifest 和对读数据 cord.json，按页序一一对位（页数必须相同；cord 与 canvas 都有宽高时逐页核对，
差 2 像素以内），把 canvas id 尾段改成页序，label 改成「第 N 頁」，叶号／半叶写进 `bim:leaf`。
图片 URL、服务 URL、缩略图 URL 一律不动（只是存储键）。已是页序编号的 manifest 原样跳过（幂等）。
旧 manifest 先备份到 <out>/backup/，供回滚。

用法：
  python3 ops/iiif/renumber_manifest.py --book 988g3f0wsu --vols 01 --out /tmp/renum            # 只生成，不上传
  python3 ops/iiif/renumber_manifest.py --book 988g3f0wsu --vols all --out /tmp/renum --upload  # 上传（要 COS secrets）
"""
import argparse
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import siku_zongmu_iiif as S  # noqa: E402

TOL = 2   # 宽高允许误差（像素）


def canvas_tail(c):
    return c['id'].rsplit('/', 1)[1]


def leaf_part(c):
    """从图片 URL 的页序段取叶号与半叶后缀：…/0006a/full/… → (6, 'a')"""
    first = c['items'][0]['items'][0]['body']['items'][0]['id']
    m = re.search(r'/(\d{4})([a-z]?)/full/', first)
    return (int(m.group(1)), m.group(2)) if m else (None, '')


def renumber(manifest, pages):
    """manifest：线上 Manifest（dict）；pages：cord 的 pages 列表（含 page、canvas{seq,width,height}）。
    返回 (新 manifest, 状态)，状态 'ok' 或 'skip'（已是页序编号）。对不上抛 ValueError。"""
    canvases = manifest['items']
    pages = sorted(pages, key=lambda p: p['page'])
    want = [p['canvas']['seq'] for p in pages]
    have = [canvas_tail(c) for c in canvases]
    if have == want:
        return manifest, 'skip'
    if len(canvases) != len(pages):
        raise ValueError(f'页数不同：manifest {len(canvases)} ≠ cord {len(pages)}')
    if [p['page'] for p in pages] != list(range(1, len(pages) + 1)):
        raise ValueError('cord 页号不是从 1 起的连续整数，不能按顺序对位')
    out = []
    for i, (c, p) in enumerate(zip(canvases, pages), 1):
        cw, ch = p['canvas'].get('width'), p['canvas'].get('height')
        if cw and ch and (abs(c['width'] - cw) > TOL or abs(c['height'] - ch) > TOL):
            raise ValueError(f'第 {i} 页宽高对不上：manifest {c["width"]}×{c["height"]} ≠ cord {cw}×{ch}')
        old, new = c['id'], c['id'].rsplit('/', 1)[0] + '/' + p['canvas']['seq']
        leaf, part = leaf_part(c)
        # canvas 内部的子 id（/page、/page/image、target）以 canvas id 为前缀，整体替换；图片/服务 URL 不含 /canvas/，不受影响
        nc = json.loads(json.dumps(c, ensure_ascii=False).replace(old, new))
        nc['label'] = {'zh': [f'第 {i} 頁']}
        if leaf is not None:
            nc['bim:leaf'] = {'leaf': leaf, **({'part': part} if part else {})}
        out.append(nc)
    return {**manifest, 'items': out}, 'ok'


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--book', required=True)
    ap.add_argument('--vols', required=True, help='册号，逗号分隔；all＝pages-books.json 里列的全部')
    ap.add_argument('--out', required=True)
    ap.add_argument('--upload', action='store_true')
    a = ap.parse_args(argv)

    import pages_iiif as P
    meta = P.load_books()[a.book]
    S.BOOK_ID = a.book
    all_vols = sorted(meta['vols'], key=int)
    vols = all_vols if a.vols == 'all' else [v for v in all_vols if int(v) in {int(x) for x in a.vols.split(',')}]
    if not vols:
        raise SystemExit(f'❌ pages-books.json 里 {a.book} 没有这些册：{a.vols}')
    idx = json.loads(S.http_get(f'{S.PUBLIC_BASE}/current/items/{a.book}/default/index.json')[0])
    chapters = {int(c['n']): c for c in idx['chapters']}
    out = os.path.abspath(a.out)
    changed, failed = 0, []
    for v in vols:
        try:
            ch = chapters[int(v)]
            cord = json.loads(S.http_get(f'{S.PUBLIC_BASE}/current/items/{a.book}/default/{ch["cord_file"]}')[0])
            raw = S.http_get(f'{S.public_url(S.manifest_key(v))}?t={os.getpid()}')[0]
            new, st = renumber(json.loads(raw), cord['pages'])
        except (KeyError, ValueError, RuntimeError) as e:
            failed.append((v, str(e)))
            print(f'  ✗ 第 {v} 册：{e}', flush=True)
            continue
        print(f'  {"✓" if st == "ok" else "·"} 第 {v} 册：{st}（{len(new["items"])} 页）', flush=True)
        if st == 'skip':
            continue
        for sub, body in (('backup', raw), ('', json.dumps(new, ensure_ascii=False, separators=(',', ':')).encode())):
            p = os.path.join(out, sub, S.manifest_key(v))
            os.makedirs(os.path.dirname(p), exist_ok=True)
            with open(p, 'wb') as f:
                f.write(body)
        changed += 1
    print(f'改写 {changed} 册，失败 {len(failed)} 册', flush=True)
    if failed:
        raise SystemExit(1)   # 有一册对不上就整批不传，免得半新半旧
    if a.upload and changed:
        # 只传新 manifest（backup 目录不在 iiif/ 前缀下之外的位置，upload_tree 只走 out 根）
        cos = S.Cos()
        for v in vols:
            p = os.path.join(out, S.manifest_key(v))
            if os.path.exists(p):
                with open(p, 'rb') as f:
                    cos.put(S.manifest_key(v), f.read(), 'application/json', S.JSON_CACHE)
                print(f'  ↑ {S.manifest_key(v)}', flush=True)


if __name__ == '__main__':
    main()
