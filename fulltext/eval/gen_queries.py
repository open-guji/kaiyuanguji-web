#!/usr/bin/env python3
"""生成 F7 评测查询集 queries.json（固定种子，可复现）。
用法: python3 -I eval/gen_queries.py --text-root DIR --books LIST [--titles titles.json] [--seed 20261012] [--per-kind 40] --out eval/queries.json
五类：title 书名 / phrase 正文短语 / rare 稀有字短语 / common 高频短语 / variant 异体字（用归一后的通行字查询，测一对一归一）。
另并入原型 42 条（queries.py）。查询均取自语料，保证至少命中一次；原型查询 kind=proto。
book-text 布局：<text-root>/**/<entry>/default/<chapter>.md（entry 为目录名前 12 位 ID 或 ID 开头）。"""
import argparse, json, os, random, sys, collections
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
from common import stream, passages, CMAP, PH  # noqa: E402

def find_chapters(root, entry):
    for dp, dn, fn in os.walk(root):
        if os.path.basename(dp) == 'default' and entry in dp.split(os.sep):
            for f in sorted(fn):
                if f.endswith('.md'):
                    yield os.path.join(dp, f)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--text-root', required=True); ap.add_argument('--books', required=True)
    ap.add_argument('--titles'); ap.add_argument('--seed', type=int, default=20261012)
    ap.add_argument('--per-kind', type=int, default=40); ap.add_argument('--out', required=True)
    a = ap.parse_args()
    rnd = random.Random(a.seed)
    books = [l.strip() for l in open(a.books, encoding='utf-8') if l.strip()]
    titles = json.load(open(a.titles, encoding='utf-8')) if a.titles else {}
    spans = []          # (orig_string) 每段的可检索字流
    freq = collections.Counter()
    for b in sorted(books):
        for fp in find_chapters(a.text_root, b):
            md = open(fp, encoding='utf-8').read()
            for s, e, _ in passages(md):
                o, n, _ = stream(md[s:e])
                st = ''.join(o)
                if len(st) >= 12 and PH not in st:
                    spans.append(st); freq.update(st)
    if not spans:
        print('no passages found', file=sys.stderr); return 3
    total = sum(freq.values())
    def pick(pred, lo, hi, tries=20000):
        out = []
        seen = set()
        for _ in range(tries):
            st = rnd.choice(spans); L = rnd.randint(lo, hi)
            if len(st) <= L: continue
            i = rnd.randrange(len(st) - L); q = st[i:i + L]
            if q in seen or not pred(q): continue
            seen.add(q); out.append(q)
            if len(out) >= a.per_kind: break
        return out
    rare_set = {c for c, k in freq.items() if k <= 3}
    common_set = {c for c, k in freq.items() if k >= total / 400}
    Q = []
    ts = sorted(set(titles.values())); rnd.shuffle(ts)
    for t in ts[:a.per_kind]:
        Q.append({'q': t, 'mode': 'fuzzy', 'kind': 'title', 'note': '书名'})
    for q in pick(lambda q: True, 4, 10): Q.append({'q': q, 'mode': 'fuzzy', 'kind': 'phrase', 'note': '随机正文短语'})
    for q in pick(lambda q: any(c in rare_set for c in q), 2, 6): Q.append({'q': q, 'mode': 'fuzzy', 'kind': 'rare', 'note': '含稀有字(语料频次≤3)'})
    for q in pick(lambda q: all(c in common_set for c in q), 2, 3): Q.append({'q': q, 'mode': 'fuzzy', 'kind': 'common', 'note': '高频字短语'})
    def variant_pred(q): return any(CMAP.get(c, c) != c for c in q)
    for q in pick(variant_pred, 3, 8):
        Q.append({'q': ''.join(CMAP.get(c, c) for c in q), 'mode': 'fuzzy', 'kind': 'variant', 'note': '原文含异体字，用归一后通行字查询；源=' + q})
    qp = os.path.join(os.path.dirname(HERE), 'queries.py'); ns = {}
    exec(open(qp, encoding='utf-8').read(), ns)
    for m, q, note in ns['Q']:
        Q.append({'q': q, 'mode': m, 'kind': 'proto', 'note': note})
    json.dump(Q, open(a.out, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    cnt = collections.Counter(x['kind'] for x in Q)
    print('total', len(Q), dict(cnt))
    return 0 if all(cnt[k] >= 20 for k in ('title', 'phrase', 'rare', 'common', 'variant')) or not titles else 4

if __name__ == '__main__':
    sys.exit(main())
