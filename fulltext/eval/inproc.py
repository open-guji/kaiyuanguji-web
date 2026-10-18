"""进程内评测：召回对拍＋延迟，直接调用 service 的 run_query，不起 HTTP。

用法：
  python3 eval/inproc.py --pack <包目录(含 index/ titles.json)> --text-root <book-text 检出根> \
      --books eval/books42.txt --queries eval/queries.json [--out report.json] [--skip-recall]

召回：每条查询 group=none 取全集（不分页、exact 不设扫描上限），与暴力子串匹配逐段比对。
  段身份 (entry, chapter, passage_start)。暴力侧用 common.passages()/stream() 重新切段，与建包同口径。
  另外核对 group=book 的 total_hits 与 hit_count 合计等于暴力段数（fuzzy 计数是聚合出来的，要单独核）。
延迟：生产口径（group=book、limit=10、per_book=3、exact_scan=3000）跑两遍，第一遍记"首遍"，第二遍记"热"。
  只是进程内单线程，不含 HTTP／网关，用来比较查询路径，不是上线判据（上线判据在上海机实测，见 docs/design.md）。
退出码：0 召回全部一致；1 有不一致。
"""
import argparse
import bisect
import json
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path[:0] = [ROOT, os.path.join(ROOT, 'service')]

from app import Params, run_query  # noqa: E402
from common import passages, query_stream, stream  # noqa: E402
from source_tantivy import TantivySource  # noqa: E402

SEP = '\x00'


def book_dir(root, entry):
    t = entry[-3:]
    for top in ('Work', 'Book'):
        d = os.path.join(root, top, t[0], t[1], t[2], entry, 'default')
        if os.path.isdir(d):
            return d
    raise FileNotFoundError(entry)


class Brute:
    def __init__(self, root, books):
        self.keys, o, n = [], [], []
        for b in books:
            d = book_dir(root, b)
            for f in sorted(os.listdir(d)):
                if not f.endswith('.md'):
                    continue
                md = open(os.path.join(d, f), encoding='utf-8').read()
                for s, e, _ in passages(md):
                    so, sn, _ = stream(md[s:e])
                    if not so:
                        continue
                    self.keys.append((b, f[:-3], s))
                    o.append(''.join(so))
                    n.append(''.join(sn))
        self.big = {'orig': SEP.join(o), 'norm': SEP.join(n)}
        self.starts, pos = [], 0
        for x in o:
            self.starts.append(pos)
            pos += len(x) + 1

    def find(self, needle, field):
        out, big = set(), self.big[field]
        i = big.find(needle)
        while i >= 0:
            out.add(self.keys[bisect.bisect_right(self.starts, i) - 1])
            i = big.find(needle, i + 1)
        return out


def params(q, mode, group, limit, per_book=3):
    return Params(q=q, truncated=False, mode=mode, group=group, limit=limit, offset=0, per_book=per_book, entry=None)


def pct(a, p):
    a = sorted(a)
    return a[min(len(a) - 1, int(len(a) * p))]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--pack', required=True)
    ap.add_argument('--text-root')
    ap.add_argument('--books')
    ap.add_argument('--queries', required=True)
    ap.add_argument('--out')
    ap.add_argument('--skip-recall', action='store_true')
    a = ap.parse_args()
    titles = json.load(open(os.path.join(a.pack, 'titles.json'), encoding='utf-8'))
    src = TantivySource(os.path.join(a.pack, 'index'), titles)
    qs = json.load(open(a.queries, encoding='utf-8'))
    rep = {'queries': len(qs)}

    if not a.skip_recall:
        books = [x.strip() for x in open(a.books) if x.strip()]
        t0 = time.time()
        brute = Brute(a.text_root, books)
        print(f'brute: {len(brute.keys)} 段，载入 {time.time() - t0:.0f}s', flush=True)
        rows, same = [], 0
        for it in qs:
            q, mode = it['q'], it['mode']
            qo, qn = query_stream(q)
            ref = brute.find(qo if mode == 'exact' else qn, 'orig' if mode == 'exact' else 'norm')
            flat = run_query(params(q, mode, 'none', 10**9), src, exact_scan=10**9)
            svc = {(h['entry'], h['chapter'], h['passage'][0]) for h in flat['hits']}
            grouped = run_query(params(q, mode, 'book', 50, 1), src, exact_scan=10**9)
            counts_ok = (min(len(ref), 10000) == grouped['total_hits']
                         and grouped['total_books'] == len({k[0] for k in ref})
                         and (grouped['has_more'] or sum(g['hit_count'] for g in grouped['groups']) == len(ref)))
            ok = svc == ref and counts_ok
            same += ok
            rows.append({'id': it.get('id'), 'q': q, 'mode': mode, 'svc': len(svc), 'ref': len(ref),
                         'missed': len(ref - svc), 'extra': len(svc - ref), 'counts_ok': counts_ok, 'ok': ok})
            if not ok:
                print('DIFF', it.get('id'), mode, q, len(svc), len(ref), counts_ok, flush=True)
        rep['recall'] = {'identical': same, 'rows': rows}
        print(f'recall: {same}/{len(qs)} 一致', flush=True)

    lat = {}
    for name in ('首遍', '热'):
        ms = []
        for it in qs:
            t = time.perf_counter()
            run_query(params(it['q'], it['mode'], 'book', 10), src)
            ms.append((time.perf_counter() - t) * 1000)
        lat[name] = {k: round(v, 1) for k, v in
                     {'p50': pct(ms, .5), 'p90': pct(ms, .9), 'p95': pct(ms, .95), 'p99': pct(ms, .99),
                      'max': max(ms)}.items()}
        print(f'延迟 {name}: ' + ' '.join(f'{k}={v}' for k, v in lat[name].items()) + ' ms', flush=True)
    rep['latency'] = lat
    if a.out:
        json.dump(rep, open(a.out, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    return 0 if a.skip_recall or rep['recall']['identical'] == len(qs) else 1


if __name__ == '__main__':
    sys.exit(main())
