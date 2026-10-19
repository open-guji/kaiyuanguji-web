"""全文搜索语义测试：简繁、异体、精确／模糊、跨标点、多一字少一字（GUJI-243）。

用法：
  进程内（直接读索引包）：python3 eval/semantic_check.py --pack <包目录(含 index/ titles.json)>
  对着跑着的服务：      python3 eval/semantic_check.py --url http://127.0.0.1:8765
  可选：--cases eval/semantic_cases.json  --out report.md  --json report.json

判定（用例见 semantic_cases.json）：
  same            同组查询（简繁／异体／带不带标点）在同一模式下 total_hits、total_books 必须相同
  found           必须有命中；给了 title 时，前 50 部书里要有这部书（书名全等），并报它排第几（排序好坏看这个）
  exact_le_fuzzy  同一查询精确命中不多于模糊（精确撞扫描上限时只报不判）
  edits           多一字／少一字／错一字：模糊（严格子串）与差一字（mode=near）各报命中数；差一字必须查得到
退出码：0 全部通过；1 有不通过；3 服务不可达。
只用标准库（--url 模式在搜索机上直接跑，不用装东西）。
"""
import argparse
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)


def http_query(base):
    def q(text, mode, limit=10):
        url = base.rstrip('/') + '/api/fulltext?' + urllib.parse.urlencode(
            {'q': text, 'mode': mode, 'group': 'book', 'limit': limit, 'per_book': 1})
        try:
            with urllib.request.urlopen(url, timeout=15) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            return {'error': f'HTTP {e.code}', 'body': e.read().decode('utf-8', 'replace')[:200]}
    return q


def inproc_query(pack):
    sys.path[:0] = [ROOT, os.path.join(ROOT, 'service')]
    from app import Params, run_query
    from source_tantivy import TantivySource
    titles = os.path.join(pack, 'titles.json')
    src = TantivySource(os.path.join(pack, 'index'),
                       json.load(open(titles, encoding='utf-8')) if os.path.exists(titles) else {})

    def q(text, mode, limit=10):
        p = Params(q=text[:60], truncated=len(text) > 60, mode=mode, group='book',
                   limit=limit, offset=0, per_book=1, entry=None)
        return run_query(p, src)
    return q


def brief(r):
    if 'error' in r:
        return r['error']
    s = f"{r['total_hits']}段/{r['total_books']}部"
    if r.get('capped'):
        s += '（封顶）'
    return s


def top_titles(r, n=3):
    return [g.get('title') or g['entry'] for g in r.get('groups', [])[:n]]


def run(cases, query):
    rows, fails = [], []

    def add(kind, name, ok, detail):
        rows.append((kind, name, ok, detail))
        if ok is False:
            fails.append(f'{kind}·{name}：{detail}')

    for c in cases['same']:
        rs = [(q, query(q, c['mode'])) for q in c['queries']]
        keys = {(r.get('total_hits'), r.get('total_books')) for _, r in rs}
        ok = len(keys) == 1 and not any('error' in r for _, r in rs)
        add('same', c['name'], ok, '；'.join(f'「{q}」{brief(r)}' for q, r in rs))

    for c in cases['found']:
        r = query(c['q'], c['mode'], 50)
        ok = 'error' not in r and r['total_hits'] > 0
        detail = f"{brief(r)}，前几部：{'、'.join(top_titles(r))}"
        if ok and c.get('title'):
            pos = [i + 1 for i, g in enumerate(r['groups']) if (g.get('title') or '') == c['title']]
            ok = bool(pos)
            detail += f"；《{c['title']}》排第 {pos[0]}" if pos else f"；前 50 部里没有《{c['title']}》"
        add('found', f"{c['mode']}「{c['q']}」", ok, detail)

    for q in cases['exact_le_fuzzy']:
        f, e = query(q, 'fuzzy'), query(q, 'exact')
        if 'error' in f or 'error' in e:
            add('exact≤fuzzy', q, False, f'模糊 {brief(f)}，精确 {brief(e)}')
            continue
        ok = None if e.get('capped') else e['total_hits'] <= f['total_hits']
        add('exact≤fuzzy', q, ok, f'模糊 {brief(f)}，精确 {brief(e)}')

    for c in cases['edits']:
        base = query(c['base'], 'fuzzy')
        parts = [f"原句 {brief(base)}"]
        ok = True
        for label, v in c['variants'].items():
            nr = query(v, 'near')
            hit = 'error' not in nr and nr.get('total_hits', 0) > 0
            ok = ok and hit
            parts.append(f"{label}「{v}」模糊 {brief(query(v, 'fuzzy'))}，差一字 {brief(nr)}")
        add('edits', c['base'], ok, '；'.join(parts))
    return rows, fails


def to_markdown(rows, fails):
    mark = {True: '✓', False: '✗', None: '—'}
    out = ['| 类 | 用例 | 结果 | 详情 |', '|---|---|---|---|']
    for kind, name, ok, detail in rows:
        out.append(f'| {kind} | {name} | {mark[ok]} | {detail} |')
    n_ok = sum(1 for r in rows if r[2] is True)
    n_judged = sum(1 for r in rows if r[2] is not None)
    out.append('')
    out.append(f'通过 {n_ok}/{n_judged}（— 为只报不判）')
    if fails:
        out += ['', '不通过：'] + [f'- {x}' for x in fails]
    return '\n'.join(out)


def main():
    ap = argparse.ArgumentParser()
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument('--pack')
    g.add_argument('--url')
    ap.add_argument('--cases', default=os.path.join(HERE, 'semantic_cases.json'))
    ap.add_argument('--out')
    ap.add_argument('--json')
    a = ap.parse_args()
    cases = json.load(open(a.cases, encoding='utf-8'))
    if a.url:
        query = http_query(a.url)
        try:
            urllib.request.urlopen(a.url.rstrip('/') + '/healthz', timeout=5)
        except Exception as e:  # noqa: BLE001
            print(f'服务不可达：{e}', file=sys.stderr)
            sys.exit(3)
    else:
        query = inproc_query(a.pack)
    rows, fails = run(cases, query)
    md = to_markdown(rows, fails)
    print(md)
    if a.out:
        open(a.out, 'w', encoding='utf-8').write(md + '\n')
    if a.json:
        json.dump([{'kind': k, 'name': n, 'ok': o, 'detail': d} for k, n, o, d in rows],
                  open(a.json, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    sys.exit(1 if fails else 0)


if __name__ == '__main__':
    main()
