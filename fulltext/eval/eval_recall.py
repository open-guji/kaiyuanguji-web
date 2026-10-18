"""召回对拍：服务 /api/fulltext（group=none 平铺全集）vs 暴力子串匹配（同一段规则、归一字流）。

用法：
  python eval_recall.py --base http://127.0.0.1:8765 --queries queries.json \
      --text-root DIR --books results/sample50.txt [--out recall.json]

--text-root 可以是扁平布局 <root>/<entry>/default/*.md，也可以是嵌套布局
<root>/<top>/<c1>/<c2>/<c3>/<entry>/default/*.md（c1..c3 取 ID 尾三字符，同 storage.shard_dirs）。

服务侧要求：FT_CANDIDATES=0（不截断候选）、FT_TIMEOUT_S 调大（默认 3 秒，高频词会 504）。
kind=common 的查询只翻第一页：比 total_hits（封顶 10000）与第一页命中是否属于暴力全集，
不做全量翻页（高频词全翻页要数十分钟）。这类条目在报告 common_checked 里计数。

退出码：0 全部一致；1 有 missed／extra／错误条目；3 服务不可达。
段规则沿用原型 common.passages()；段身份＝(entry, chapter, passage_start)。
"""
import argparse, bisect, json, os, socket, sys, urllib.parse, urllib.request, urllib.error

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..'))
from common import passages, query_stream, stream  # noqa: E402  (原型模块，不复制)

PAGE = 50            # /api/fulltext 的 limit 上限
TOTAL_HITS_CAP = 10000  # 服务端 total_hits 封顶（service/app.py）
SEP = '\x00'         # 段间分隔符：查询字流不含它，所以命中不会跨段


def entry_dir(text_root, entry):
    """找书的 default 目录：先试扁平布局，再试嵌套布局。"""
    flat = os.path.join(text_root, entry, 'default')
    if os.path.isdir(flat):
        return flat
    c1, c2, c3 = entry[-3], entry[-2], entry[-1]
    for top in sorted(os.listdir(text_root)):
        d = os.path.join(text_root, top, c1, c2, c3, entry, 'default')
        if os.path.isdir(d):
            return d
    raise FileNotFoundError(f'book-text 缺失: {entry} (root={text_root})')


class Corpus:
    """启动时一次性载入：每段的 orig/norm 字流拼成大串，段间用 SEP 连接。"""

    def __init__(self, text_root, books):
        self.keys = []                 # 段身份，下标与 starts 对齐
        parts = {'orig': [], 'norm': []}
        for entry in books:
            d = entry_dir(text_root, entry)
            for fn in sorted(os.listdir(d)):
                if not fn.endswith('.md'):
                    continue
                chapter = fn[:-3]
                with open(os.path.join(d, fn), encoding='utf-8') as f:
                    md = f.read()
                for s, e, _ in passages(md):
                    o, n, _ = stream(md[s:e])   # 与 common.locate 同口径：每段单独归一
                    self.keys.append((entry, chapter, s))
                    parts['orig'].append(''.join(o))
                    parts['norm'].append(''.join(n))
        self.big = {k: SEP.join(v) for k, v in parts.items()}
        self.starts = []
        pos = 0
        for p in parts['orig']:
            self.starts.append(pos)
            pos += len(p) + 1

    def brute(self, needle, field):
        """返回 {(entry, chapter, passage_start)}：needle 在哪些段里出现。"""
        hits = set()
        if not needle:
            return hits
        big = self.big[field]
        i = big.find(needle)
        while i >= 0:
            hits.add(self.keys[bisect.bisect_right(self.starts, i) - 1])
            i = big.find(needle, i + 1)
        return hits


def fetch_page(base, q, mode, offset, group):
    qs = urllib.parse.urlencode({'q': q, 'mode': mode, 'group': group,
                                 'limit': PAGE, 'offset': offset})
    with urllib.request.urlopen(f'{base}/api/fulltext?{qs}', timeout=600) as r:
        return json.load(r)


def service_segments(base, q, mode):
    """group=none 翻页取全部段；返回 {(entry, chapter, passage_start)}。"""
    out, offset = set(), 0
    while True:
        body = fetch_page(base, q, mode, offset, 'none')
        for h in body.get('hits', []):
            out.add((h['entry'], h['chapter'], h['passage'][0]))
        if not body.get('has_more'):
            return out
        offset += PAGE


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--base', required=True)
    ap.add_argument('--queries', required=True)
    ap.add_argument('--text-root', required=True)
    ap.add_argument('--books', required=True, help='每行一个书 ID（sample50.txt）')
    ap.add_argument('--out', default='recall.json')
    a = ap.parse_args()

    queries = json.load(open(a.queries, encoding='utf-8'))
    books = [l.strip() for l in open(a.books, encoding='utf-8') if l.strip()]
    corpus = Corpus(a.text_root, books)

    report = {'queries': len(queries), 'identical': 0, 'common_checked': 0,
              'missed': [], 'extra': [], 'errors': []}
    for item in queries:
        q, mode, kind = item['q'], item['mode'], item.get('kind')
        field = 'orig' if mode == 'exact' else 'norm'
        q_orig, q_norm = query_stream(q)
        ref = corpus.brute(q_orig if field == 'orig' else q_norm, field)
        try:
            if kind == 'common':
                body = fetch_page(a.base, q, mode, 0, 'none')
                report['common_checked'] += 1
                want_total = min(len(ref), TOTAL_HITS_CAP)
                sample = {(h['entry'], h['chapter'], h['passage'][0]) for h in body.get('hits', [])}
                if body.get('total_hits') != want_total:
                    report['missed'].append({'q': q, 'note': 'total_hits 不符',
                                             'service': body.get('total_hits'), 'brute': want_total})
                elif not sample <= ref:
                    report['extra'].append({'q': q, 'note': '第一页有非命中段',
                                            'extra': [list(x) for x in sorted(sample - ref)]})
                else:
                    report['identical'] += 1
                continue
            svc = service_segments(a.base, q, mode)
        except urllib.error.HTTPError as ex:
            report['errors'].append({'q': q, 'http': ex.code})
            continue
        except (socket.timeout, TimeoutError) as ex:
            report['errors'].append({'q': q, 'timeout': str(ex)})
            continue
        except (urllib.error.URLError, ConnectionError) as ex:
            print(f'服务不可达: {ex}', file=sys.stderr)
            return 3
        miss, extra = sorted(ref - svc), sorted(svc - ref)
        if not miss and not extra:
            report['identical'] += 1
        if miss:
            report['missed'].append({'q': q, 'missing': [list(x) for x in miss]})
        if extra:
            report['extra'].append({'q': q, 'extra': [list(x) for x in extra]})

    with open(a.out, 'w', encoding='utf-8') as f:
        json.dump(report, f, ensure_ascii=False, indent=2)
    print(f"queries={report['queries']} identical={report['identical']} "
          f"common_checked={report['common_checked']} missed={len(report['missed'])} "
          f"extra={len(report['extra'])} errors={len(report['errors'])}")
    ok = not report['missed'] and not report['extra'] and not report['errors']
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main())
