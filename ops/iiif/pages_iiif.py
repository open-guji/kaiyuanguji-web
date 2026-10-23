#!/usr/bin/env python3
"""任一部书的书影：读 cv 页表与页图 → 切三档 WebP → IIIF Presentation 3 manifest → 上传 COS `iiif/` 前缀。

四庫總目（96mid1ogzk）有 IA／Commons 回退源，仍用 siku_zongmu_iiif.py；别的书（北行日錄、全唐文…）没有 IA 条目，
页图只在 cv 页表里（R2 `pack/source/pages/<书id>/<册>/r<NNN>.json`，设计见 open-guji-cv
`doc/design/古籍图片全流程-源件页图管线与IIIF.md`），用本脚本。切法、路径、上传、核对全部借 siku_zongmu_iiif.py，
只是 manifest 里只有本站一个图源。

书的名字、各册卷次、影像来源写在 pages-books.json；新书先在那里加一条，再在 cv 里 `guji source register／ia` 登记页表。

用法：
  python3 ops/iiif/pages_iiif.py --book 988g7gsqhd --vols 01 --out /tmp/iiif
  python3 ops/iiif/pages_iiif.py --book 995ejelvk0 --vols all --out /tmp/iiif --upload --verify
"""
import argparse
import json
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import siku_zongmu_iiif as S  # noqa: E402

PD_MARK = 'http://creativecommons.org/publicdomain/mark/1.0/'


def load_books(path=os.path.join(HERE, 'pages-books.json')):
    with open(path, encoding='utf-8') as f:
        return json.load(f)


def vol_label(meta, v):
    juan = meta['vols'][f'{v:02d}'].get('juan', '')
    return f'{meta["title"]} 第 {v} 冊' + (f' {juan}' if juan else '')


def build_canvas(vol, c):
    """只有本站一个图源（没有 IA／Commons 可回退）；结构与四庫總目的 canvas 相同，网站按同一套规则取页序。"""
    cid = S.canvas_id(vol, c['seq'])
    by = {n: (tw, th) for n, tw, th, _ in c['tiers']}
    rw, rh = by['read']
    tw, th = by['thumb']
    item = {
        'id': S.public_url(S.tier_key(vol, c['seq'], rw)), 'type': 'Image', 'format': 'image/webp',
        'width': rw, 'height': rh, 'label': {'zh': ['本站']},
        'service': [{'id': S.public_url(S.image_base_key(vol, c['seq'])), 'type': 'ImageService3', 'profile': 'level0'}],
    }
    label = f'第 {c["leaf"]} 頁' + (c['seq'][4:] if len(c['seq']) > 4 else '')
    return {
        'id': cid, 'type': 'Canvas', 'label': {'zh': [label]}, 'width': c['width'], 'height': c['height'],
        'thumbnail': [{'id': S.public_url(S.tier_key(vol, c['seq'], tw)), 'type': 'Image',
                       'format': 'image/webp', 'width': tw, 'height': th}],
        'items': [{
            'id': f'{cid}/page', 'type': 'AnnotationPage',
            'items': [{
                'id': f'{cid}/page/image', 'type': 'Annotation', 'motivation': 'painting',
                'target': cid, 'body': {'type': 'Choice', 'items': [item]},
            }],
        }],
    }


def build_manifest(meta, vol, canvases, table):
    vm = meta['vols'][f'{vol:02d}']
    md = [{'label': {'zh': ['冊']}, 'value': {'zh': [f'{vol}']}}]
    if vm.get('juan'):
        md.insert(0, {'label': {'zh': ['卷次']}, 'value': {'zh': [vm['juan']]}})
    md.append({'label': {'zh': ['影像來源']}, 'value': {'zh': [vm.get('source') or meta['source']]}})
    md.append({'label': {'zh': ['頁表']}, 'value': {'zh': [f'r{table["rev"]:03d}']}})
    man = {
        '@context': 'http://iiif.io/api/presentation/3/context.json',
        'id': S.public_url(S.manifest_key(vol)), 'type': 'Manifest',
        'label': {'zh': [vol_label(meta, vol)]},
        'metadata': md,
        'rights': meta.get('rights', PD_MARK),
        'requiredStatement': {'label': {'zh': ['影像來源']}, 'value': {'zh': [meta['source'] + '；開源古籍切片']}},
        'viewingDirection': 'right-to-left',
        'partOf': [{'id': S.public_url(S.collection_key()), 'type': 'Collection'}],
        'items': [build_canvas(vol, c) for c in canvases],
    }
    home = vm.get('homepage') or meta.get('homepage')
    if home:
        man['homepage'] = [{'id': home, 'type': 'Text', 'label': {'zh': ['影像原條目']}, 'format': 'text/html'}]
    return man


def build_collection(meta, vols_present):
    return {
        '@context': 'http://iiif.io/api/presentation/3/context.json',
        'id': S.public_url(S.collection_key()), 'type': 'Collection',
        'label': {'zh': [meta['title']]},
        'rights': meta.get('rights', PD_MARK),
        'viewingDirection': 'right-to-left',
        'items': [{'id': S.public_url(S.manifest_key(v)), 'type': 'Manifest',
                   'label': {'zh': [vol_label(meta, v)]}} for v in sorted(vols_present)],
    }


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--book', required=True, help='book-index 书 id（pages-books.json 里要有）')
    ap.add_argument('--vols', required=True, help='册号，逗号分隔；all＝pages-books.json 里列的全部')
    ap.add_argument('--out', required=True, help='输出目录（其下按 COS key 布局）')
    ap.add_argument('--cache', default=None, help='页图缓存目录（默认 <out>/../cache）')
    ap.add_argument('--jobs', type=int, default=None)
    ap.add_argument('--upload', action='store_true')
    ap.add_argument('--verify', action='store_true')
    ap.add_argument('--force', action='store_true')
    ap.add_argument('--report')
    a = ap.parse_args(argv)

    books = load_books()
    if a.book == '96mid1ogzk':
        raise SystemExit('❌ 四庫總目用 siku_zongmu_iiif.py --source pages（有 IA／Commons 回退源）')
    if a.book not in books:
        raise SystemExit(f'❌ pages-books.json 里没有 {a.book}，先加一条（书名、各册卷次、影像来源）')
    meta = books[a.book]
    S.BOOK_ID = a.book
    all_vols = sorted(int(v) for v in meta['vols'])
    vols = all_vols if a.vols == 'all' else [int(v) for v in a.vols.split(',') if v.strip()]
    for v in vols:
        if v not in all_vols:
            raise SystemExit(f'❌ pages-books.json 里 {a.book} 没有第 {v} 册')
    out = os.path.abspath(a.out)
    cache = os.path.abspath(a.cache or os.path.join(os.path.dirname(out), 'cache'))
    os.makedirs(out, exist_ok=True)
    os.makedirs(cache, exist_ok=True)

    report = {'book': a.book, 'volumes': {}}
    for v in vols:
        t0 = time.perf_counter()
        table = S.load_page_table(v)
        if table is None:
            raise SystemExit(f'❌ {a.book}/{v:02d} 还没有 cv 页表（guji source register／ia 先登记）')
        if table.get('book_id') != a.book:
            raise SystemExit(f'❌ 页表的书 id {table.get("book_id")} ≠ {a.book}')
        print(f'{a.book}/{v:02d} 页表 r{table["rev"]:03d}：{len(table["pages"])} 页', flush=True)
        r = S.slice_volume(v, {'ia': None}, {}, out, cache, None, a.jobs, table=table)
        r['stats'].update(page_table=f'r{table["rev"]:03d}', wall_s=round(time.perf_counter() - t0, 1), commons=None)
        with open(os.path.join(out, S.manifest_key(v)), 'w', encoding='utf-8') as f:
            json.dump(build_manifest(meta, v, r['canvases'], table), f, ensure_ascii=False, separators=(',', ':'))
        report['volumes'][f'{v:02d}'] = r
        print('  ' + json.dumps(r['stats'], ensure_ascii=False), flush=True)

    present = set(vols)
    try:
        present |= S.existing_volumes(all_vols)
    except RuntimeError as e:
        if a.upload:
            raise SystemExit(f'❌ {e}；不更新 Collection，免得漏掉已上线的册') from None
        print(f'  ⚠ {e}；本地 Collection 只列本次的册', file=sys.stderr)
    with open(os.path.join(out, S.collection_key()), 'w', encoding='utf-8') as f:
        json.dump(build_collection(meta, present), f, ensure_ascii=False, separators=(',', ':'))

    report['samples'] = S.sample_sheet(out, report)
    up_keys = None
    if a.upload:
        report['upload'] = S.upload_tree(out, force=a.force)
        up_keys = report['upload'].pop('uploaded_keys')
        print('上传：' + json.dumps(report['upload'], ensure_ascii=False), flush=True)
    if a.verify:
        report['verify'] = S.verify_online(out, uploaded_keys=None if (a.force or not a.upload) else up_keys)
        vr = report['verify']
        print(f'核对：{vr["checked"]} 个文件，{len(vr["bad"])} 个不对', flush=True)
        for key, why in vr['bad'][:50]:
            print(f'  ✗ {key}：{why}')
    if a.report:
        slim = {**report, 'volumes': {k: {'stats': r['stats'], 'canvases': [c['seq'] for c in r['canvases']]}
                                      for k, r in report['volumes'].items()}}
        with open(a.report, 'w', encoding='utf-8') as f:
            json.dump(slim, f, ensure_ascii=False, indent=1)
    summary = os.environ.get('GITHUB_STEP_SUMMARY')
    if summary:
        with open(summary, 'a', encoding='utf-8') as f:
            f.write(S.markdown_summary(report).replace('四庫總目 IIIF 切片', f'{meta["title"]} IIIF 切片'))
    if a.verify and report['verify']['bad']:
        sys.exit(1)


if __name__ == '__main__':
    main()
