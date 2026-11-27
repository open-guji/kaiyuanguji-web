#!/usr/bin/env python3
"""自做书名单：从 book-text 的 Book/*/*/*/<书id>/manifest.json 里推出，不再手工登记。

「自做书」＝ manifest 里任一版本带 `is_original: true`（本项目从书影自做的文本）。网站有两处要这份名单：
  · proofing-sync（精校单每日同步）：中心库工作区名单 PROOF_WS —— `--proof-ws`；
  · 书影切片（pages_iiif.py）：册目录、题名、影像来源 —— `scan()` / `derive_pages_books()`，
    手写的 pages-books.json 只留自动推不出的（扫描册比文本册多的册目录、人工定的题名与来源、homepage、rights）。

book-text 只需有 manifest.json 与 default/index.json（ops/fetch-book-text-manifests.sh 稀疏取）。
用法：python3 ops/iiif/original_books.py <book-text 根> [--proof-ws | --json]
"""
import argparse
import glob
import json
import os
import re
import sys

# 旧工作区名：这两本的中心库工作区不叫书 id（历史原因），改名前照旧
WS_ALIAS = {'96mid1ogzk': 'siku-zongmu', '988g7gsqhd': 'beixing-guben'}
PREFIX = re.compile(r'^開源古籍\s*CV\s*整理\s*[（(](.*)[）)]\s*$')


def _load(path):
    with open(path, encoding='utf-8') as f:
        return json.load(f)


def edition_of(source_name):
    """「開源古籍CV整理（嘉慶內府本，清華 CADAL）」→「嘉慶內府本，清華 CADAL」；不是这个格式就原样。"""
    m = PREFIX.match(source_name or '')
    return (m.group(1) if m else source_name or '').strip()


def scan(root):
    """→ {书id: {'source_name', 'chapters': [{'n','file','title'}]}}，只含 is_original 的书，按书 id 排序。"""
    out = {}
    for mp in sorted(glob.glob(os.path.join(root, 'Book', '*', '*', '*', '*', 'manifest.json'))):
        try:
            man = _load(mp)
        except (OSError, ValueError) as e:
            print(f'⚠ {mp} 读不了：{e}', file=sys.stderr)
            continue
        vers = [v for v in man.get('versions', []) if v.get('is_original')]
        if not vers:
            continue
        bid = man.get('id') or os.path.basename(os.path.dirname(mp))
        default = next((v for v in vers if v.get('key') == 'default'), vers[0])
        chapters = []
        ip = os.path.join(os.path.dirname(mp), 'default', 'index.json')
        if os.path.exists(ip):
            try:
                chapters = [{'n': c.get('n'), 'file': c.get('file'), 'title': c.get('title', '')}
                            for c in _load(ip).get('chapters', [])]
            except (OSError, ValueError) as e:
                print(f'⚠ {ip} 读不了：{e}', file=sys.stderr)
        out[bid] = {'source_name': default.get('source_name', ''), 'chapters': chapters}
    return dict(sorted(out.items()))


def proof_ws(books):
    """中心库工作区 id 列表（每本自做书一个；旧的两本用旧名）。"""
    return [WS_ALIAS.get(b, b) for b in books]


def vol_key(ch, width):
    """章 → 册号。book-text 里一册一章，章 file 名（'001'）的数字就是册号；位数由书定（全唐文 248 册 3 位，其余 2 位）。"""
    return str(int(ch['file'])).zfill(width)


def derive_pages_books(books, width_of=None):
    """自做书 → pages-books.json 同结构的条目（题名／来源取 source_name，册目录取 default/index.json 的章）。
    章为空（还没有文本）的书不出条目：册目录推不出，要手写。width_of：{书id: 册号位数}，缺省 2、章号 ≥100 时 3。"""
    out = {}
    for bid, b in books.items():
        chs = [c for c in b['chapters'] if str(c.get('file') or '').isdigit()]
        if not chs:
            continue
        w = (width_of or {}).get(bid) or (3 if max(int(c['file']) for c in chs) >= 100 else 2)
        ed = edition_of(b['source_name'])
        out[bid] = {
            'title': ed or bid,
            'source': ed,
            'vols': {vol_key(c, w): ({'juan': c['title']} if c.get('title') else {}) for c in chs},
        }
    return out


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('root', help='book-text 根（或只含 Book/*/…/manifest.json 的稀疏取出目录）')
    g = ap.add_mutually_exclusive_group()
    g.add_argument('--proof-ws', action='store_true', help='打印工作区名单，逗号分隔')
    g.add_argument('--json', action='store_true', help='打印自做书与自动推出的 pages-books 条目')
    a = ap.parse_args(argv)
    books = scan(a.root)
    if not books:
        raise SystemExit(f'❌ {a.root} 下没找到 is_original 的书（目录不对？）')
    if a.proof_ws:
        print(','.join(proof_ws(books)))
    else:
        print(json.dumps({'books': list(books), 'pages_books': derive_pages_books(books)}, ensure_ascii=False, indent=1))


if __name__ == '__main__':
    main()
