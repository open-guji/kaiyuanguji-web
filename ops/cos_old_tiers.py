#!/usr/bin/env python3
"""单版整页上线后：列出 COS 上各书影旧档（默认只读 dry-run；加 --delete 才删，用户 2026-11-19 验收后点头）。

用法（需 COS_SECRET_ID／COS_SECRET_KEY／COS_BUCKET）：
    python3 ops/cos_old_tiers.py --books 96mid1ogzk,995ejelvk0 --out /tmp/old-tiers

按 iiif/<书>/ 下的对象分类（相对书目录）：
  保留：collection.json、<册>/manifest.json、<册>/srcbw/**（新单版整页）
  旧档（建议删）：
    image:<宽>   <册>/[<版本段>/]<页序>/full/<宽>,/0/default.webp 以及 info.json（旧 300／1200／原宽各档，含换图源的版本段如 wyg、qiefen2）
    src2400      <册>/src/**（文淵閣 2400 宽源图档，已被 srcbw 取代）
  其他：认不出的一律列出，不建议删。
输出每书各类对象数与 GB，并把「建议删」的键写进 <out>/<书>.txt（一行一个键）。
"""
import argparse, collections, os, re, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cos_usage  # noqa: E402
import cos_prefix_delete  # noqa: E402
from concurrent.futures import ThreadPoolExecutor  # noqa: E402

TIER = re.compile(r'^(?P<vol>[^/]+)/(?:(?P<seg>[A-Za-z][A-Za-z0-9]*)/)?(?P<seq>\d{4}[a-z]?)/full/(?P<w>\d+|max),/0/default\.(?:webp|jpg)$')
INFO = re.compile(r'^(?P<vol>[^/]+)/(?:(?P<seg>[A-Za-z][A-Za-z0-9]*)/)?(?P<seq>\d{4}[a-z]?)/info\.json$')


def classify(rel):
    """相对书目录的键 → (类别, 是否建议删)。"""
    if rel == 'collection.json' or rel.endswith('/manifest.json') and rel.count('/') == 1:
        return 'keep:manifest', False
    parts = rel.split('/')
    if len(parts) > 1 and parts[1] == 'srcbw':
        return 'keep:srcbw', False
    if len(parts) > 1 and parts[1] == 'src':
        return 'src2400', True
    m = TIER.match(rel)
    if m:
        return f'image:{m.group("w")}' + (f'（段 {m.group("seg")}）' if m.group('seg') else ''), True
    if INFO.match(rel):
        return 'image:info.json', True
    return 'other', False


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--books', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--delete', action='store_true', help='真删「建议删」的键（逐个 DELETE，可重跑）')
    ap.add_argument('--limit', type=int, default=0, help='--delete 时每书最多删多少个（0＝不限；先小批量试删用）')
    a = ap.parse_args()
    sid, skey, bucket = os.environ['COS_SECRET_ID'], os.environ['COS_SECRET_KEY'], os.environ['COS_BUCKET']
    region = os.environ.get('COS_REGION', 'ap-shanghai')
    os.makedirs(a.out, exist_ok=True)
    for book in a.books.split(','):
        prefix = f'iiif/{book}/'
        objs, _ = cos_usage.list_prefix(sid, skey, bucket, region, prefix)
        stat = collections.defaultdict(lambda: [0, 0])
        drop = []
        examples = {}
        for o in objs:
            key, size = (o['key'], o['size']) if isinstance(o, dict) else (o[0], o[1])
            rel = key[len(prefix):]
            cat, d = classify(rel)
            stat[cat][0] += 1
            stat[cat][1] += size
            examples.setdefault(cat, key)
            if d:
                drop.append(key)
        print(f'\n== {book}：共 {len(objs)} 个对象 ==')
        for cat in sorted(stat):
            n, b = stat[cat]
            print(f'  {cat:<28} {n:>8} 个  {b / 1e9:8.2f} GB   例：{examples[cat]}')
        tot = sum(stat[c][1] for c in stat if not c.startswith('keep') and c != 'other')
        print(f'  → 建议删合计 {len(drop)} 个，{tot / 1e9:.2f} GB')
        with open(os.path.join(a.out, f'{book}.txt'), 'w', encoding='utf-8') as f:
            f.write('\n'.join(drop) + ('\n' if drop else ''))
        if a.delete:
            if not stat.get('keep:srcbw', [0])[0] or not stat.get('keep:manifest', [0])[0]:
                print(f'  ✗ {book}：没有 srcbw 或 manifest，拒绝删除')
                continue
            ks = drop[:a.limit] if a.limit else drop
            ok = 0
            with ThreadPoolExecutor(16) as ex:
                for r in ex.map(lambda k: cos_prefix_delete.delete_key(sid, skey, bucket, region, k), ks):
                    ok += bool(r)
            print(f'  ✓ {book}：已删 {ok}/{len(ks)} 个（建议删共 {len(drop)}）')


if __name__ == '__main__':
    main()
