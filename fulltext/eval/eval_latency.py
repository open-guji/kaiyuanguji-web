"""/api/fulltext 延迟压测（HTTP）：冷／热两档 × 并发数，输出分位数、超时数、错误数（分类型）。

用法（每个并发档单独起一次服务，冷档才有意义）：
  # 1. 起服务，指向索引包
  FT_INDEX_DIR=<包>/index FT_TITLES=<包>/titles.json FT_PORT=8765 python3 service/run.py &
  # 2. 查询集用 eval/queries.json（244 条），并发 1/4/8 各跑一次，每次重启服务
  python3 eval/eval_latency.py --base http://127.0.0.1:8765 --queries eval/queries.json \
      --concurrency 4 --passes 2 --group book --label FULL-c4 --out results/latency_FULL_c4.json
  只比查询路径、不要 HTTP 时用 eval/inproc.py。

口径：
  - 冷（首次）：本次进程里每条查询的第一遍（每条一次）。这是服务进程 LRU 冷，不是 OS 页缓存冷；
    要得到服务冷数，必须先重启服务再跑。
  - 热（缓存命中）：之后各遍；丢弃热序列前 20 次预热（DISCARD_WARMUP）。
  - 超时：服务端 HTTP 504 与客户端超时分别计入 timeouts；客户端超时默认 = FT_TIMEOUT_S + 2 s（--timeout 可覆盖）。
  - 错误：其它非 200 的 HTTP 码或网络／IO 异常，按类型计入 error_types。
  - group 默认 book（验收口径，limit=10）；group=none 仅用于召回／评测模式。输出里记录 group、limit、
    exact_scan，避免两种口径混着比。
  - 并发：线程池，每个请求单独计时（perf_counter，毫秒）。

退出码：0 完成（不判过不过，判定在报告里做）；3 服务不可达。
"""
import argparse
import json
import os
import socket
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter
from concurrent.futures import ThreadPoolExecutor

DISCARD_WARMUP = 20  # 热序列前 20 次不计入统计
SERVER_TIMEOUT_S = float(os.environ.get('FT_TIMEOUT_S', '3.0'))  # 与服务端 FT_TIMEOUT_S 对齐
TIMEOUT_S = SERVER_TIMEOUT_S + 2.0  # 客户端默认超时：服务端超时 + 2 s 余量


def percentile(values, p):
    """线性插值分位数（与 numpy 默认一致）。values 可乱序；空列表返回 None。"""
    if not values:
        return None
    xs = sorted(values)
    if len(xs) == 1:
        return xs[0]
    k = (len(xs) - 1) * (p / 100.0)
    lo = int(k)
    hi = min(lo + 1, len(xs) - 1)
    return xs[lo] + (xs[hi] - xs[lo]) * (k - lo)


def is_timeout(st):
    return st == 504 or st == 'timeout'


def summarize(records):
    """records: [(latency_ms, status)]。status：HTTP 码、'timeout'（客户端超时）、'exc:<类型>'，或 None。

    返回 n、p50、p90、p95、p99、max、超时数（504 + 客户端超时）、错误数（其它）与 error_types。
    延迟分位数只用 200 的请求。
    """
    ok_lat = [lat for lat, st in records if st == 200]
    timeouts = sum(1 for _, st in records if is_timeout(st))
    bad = [st for _, st in records if st != 200 and not is_timeout(st)]
    return {
        'n': len(records),
        'p50': percentile(ok_lat, 50),
        'p90': percentile(ok_lat, 90),
        'p95': percentile(ok_lat, 95),
        'p99': percentile(ok_lat, 99),
        'max': max(ok_lat) if ok_lat else None,
        'timeouts': timeouts,
        'errors': len(bad),
        'error_types': dict(Counter(str(s) for s in bad)),
    }


def split_cold_hot(sequence, n_queries):
    """sequence: [(query, latency_ms, status)]，按发出顺序（第一遍在前）。

    按位置切分：前 n_queries 条为冷档（每条查询串的第一遍），其余为热档并丢弃前 DISCARD_WARMUP 条。
    不按查询串去重：queries 里可能有重复串（如两次出现的同一词），按串去重会让冷热条数对不上。
    返回 (cold_records, hot_records)，元素为 (latency_ms, status)。
    """
    cold = [(lat, st) for _, lat, st in sequence[:n_queries]]
    hot = [(lat, st) for _, lat, st in sequence[n_queries:]]
    return cold, hot[DISCARD_WARMUP:]


OS_CACHE_CHOICES = ('cold', 'warm', 'unknown')
SERVICE_WARM_CHOICES = ('on', 'off', 'unknown')
_OS_CACHE_TEXT = {'cold': '冷', 'warm': '暖', 'unknown': '未知'}


def tier_labels(os_cache, service_warm):
    """冷／热两档分开报的标注（Edric 决定：冷档＝服务进程 LRU 冷，并写明 OS 页缓存冷／暖，两种不混成一档）。

    os_cache 由操作者声明（脚本无法探测页缓存）：先 drop_caches 或换冷副本则为 cold，未做则为 warm。
    """
    if os_cache not in OS_CACHE_CHOICES or service_warm not in SERVICE_WARM_CHOICES:
        raise ValueError(f'os_cache/service_warm 取值非法: {os_cache}, {service_warm}')
    cache = _OS_CACHE_TEXT[os_cache]
    return {
        'cold': f'冷档：服务进程 LRU 冷 + OS 页缓存{cache}',
        'hot': f'热档：服务进程 LRU 热 + OS 页缓存{cache}',
        'os_page_cache': os_cache,
        'service_warm': service_warm,
    }


def build_url(base, q, mode, group='book', limit=10):
    qs = urllib.parse.urlencode({'q': q, 'mode': mode, 'group': group, 'limit': str(limit)})
    return f"{base.rstrip('/')}/api/fulltext?{qs}"


def _classify(exc):
    if isinstance(exc, (socket.timeout, TimeoutError)):
        return 'timeout'
    return f'exc:{type(exc).__name__}'


def one_request(base, item, group, limit, timeout):
    """发一次请求，返回 (query, latency_ms, status)。"""
    q = item['q']
    mode = item.get('mode', 'fuzzy')
    url = build_url(base, q, mode, group, limit)
    t0 = time.perf_counter()
    try:
        with urllib.request.urlopen(url, timeout=timeout) as r:
            r.read()
            st = r.status
    except urllib.error.HTTPError as e:  # HTTPError 是 URLError 子类，须先捕获
        st = e.code
    except urllib.error.URLError as e:
        st = _classify(e.reason)
    except OSError as e:  # 读超时等直接抛出的 socket 异常
        st = _classify(e)
    return q, (time.perf_counter() - t0) * 1000.0, st


def check_reachable(base):
    try:
        with urllib.request.urlopen(f"{base.rstrip('/')}/healthz", timeout=TIMEOUT_S) as r:
            return r.status == 200
    except (urllib.error.URLError, OSError):
        return False


def run(base, queries, concurrency, passes, group='book', limit=10, timeout=TIMEOUT_S):
    """冷序列（每条一次）＋热序列（重复 passes 遍）。两者都经同一个线程池发出。

    线程池按发出顺序取任务，所以 sequence 的顺序就是「第一遍在前」。
    """
    plan = list(queries) * (1 + passes)
    with ThreadPoolExecutor(max_workers=concurrency) as ex:
        results = list(ex.map(lambda it: one_request(base, it, group, limit, timeout), plan))
    return results


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--base', default='http://127.0.0.1:8765')
    ap.add_argument('--queries', required=True, help='JSON 列表，每项至少含 q，可选 mode（默认 fuzzy）')
    ap.add_argument('--concurrency', type=int, default=1, help='并发数（默认 1；验收分档跑 1、4、8）')
    ap.add_argument('--passes', type=int, default=8, help='热序列重复遍数（每遍 = 查询条数）')
    ap.add_argument('--group', choices=['book', 'none'], default='book',
                    help='分组口径（默认 book＝验收口径；none 仅用于召回／评测模式）')
    ap.add_argument('--limit', type=int, default=10, help='返回条数（默认 10）')
    ap.add_argument('--timeout', type=float, default=TIMEOUT_S,
                    help=f'客户端超时秒数（默认 FT_TIMEOUT_S+2 = {TIMEOUT_S:g}）')
    ap.add_argument('--exact-scan', dest='exact_scan', default=os.environ.get('FT_EXACT_SCAN', 'unknown'),
                    help='服务端 FT_EXACT_SCAN，仅记录到结果（默认取环境变量）；不修改服务配置')
    ap.add_argument('--label', default='', help='结果标记，如 sample17-20261014')
    ap.add_argument('--os-cache', choices=OS_CACHE_CHOICES, default='unknown',
                    help='OS 页缓存状态（操作者声明）：drop_caches／换冷副本后起服务填 cold；未清则 warm')
    ap.add_argument('--service-warm', choices=SERVICE_WARM_CHOICES, default='unknown',
                    help='服务是否经启动预热（FT_WARM）：on／off，仅记录')
    ap.add_argument('--out', default='', help='输出 JSON 路径；缺省只打印')
    args = ap.parse_args(argv)

    if not check_reachable(args.base):
        print(f'服务不可达: {args.base}/healthz', file=sys.stderr)
        return 3
    with open(args.queries, encoding='utf-8') as f:
        queries = json.load(f)

    t0 = time.time()
    seq = run(args.base, queries, args.concurrency, args.passes, args.group, args.limit, args.timeout)
    cold, hot = split_cold_hot(seq, len(queries))
    labels = tier_labels(args.os_cache, args.service_warm)
    out = {
        'label': args.label,
        'base': args.base,
        'queries': len(queries),
        'concurrency': args.concurrency,
        'passes': args.passes,
        'group': args.group,
        'limit': args.limit,
        'exact_scan': args.exact_scan,
        'timeout_s': args.timeout,
        'discard_warmup': DISCARD_WARMUP,
        'wall_s': round(time.time() - t0, 2),
        'cold': {'tier': labels['cold'], **summarize(cold)},
        'hot': {'tier': labels['hot'], **summarize(hot)},
        'os_page_cache': labels['os_page_cache'],
        'service_warm': labels['service_warm'],
    }
    text = json.dumps(out, ensure_ascii=False, indent=2)
    print(text)
    if args.out:
        with open(args.out, 'w', encoding='utf-8') as f:
            f.write(text + '\n')
    return 0


if __name__ == '__main__':
    sys.exit(main())
