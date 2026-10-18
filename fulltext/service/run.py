"""启动检索服务：python3 service/run.py（环境变量见 config.py；FT_INDEX_DIR、FT_TITLES 必填）。"""
import json
import os
import sys
import threading
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.dirname(HERE))

import app  # noqa: E402
import config  # noqa: E402
from source_tantivy import TantivySource  # noqa: E402


def load_warm_terms(path):
    with open(path, encoding='utf-8') as f:
        return [t for t in (line.strip() for line in f) if t and not t.startswith('#')]


def main():
    t_start = time.monotonic()
    cfg = config.load()
    with open(cfg.titles, encoding='utf-8') as f:
        titles = json.load(f)
    boost = {}
    if cfg.boost and os.path.isfile(cfg.boost):
        with open(cfg.boost, encoding='utf-8') as f:
            boost = json.load(f)
    source = TantivySource(cfg.index_dir, titles)
    service = app.Service(source, cfg.exact_scan, boost=boost,
                          max_concurrent=cfg.max_concurrent, queue_max=cfg.queue_max,
                          timeout_s=cfg.timeout_s)
    # 先开端口、就绪前一律 503 warming；预热完成后才 ready。
    service.ready = not cfg.warm
    threading.Thread(target=app.serve, args=(service, cfg.host, cfg.port), daemon=True).start()
    print(f'serving {cfg.host}:{cfg.port} exact_scan={cfg.exact_scan} warm={cfg.warm}', flush=True)
    if cfg.warm:
        terms_path = cfg.warm_terms or os.path.join(HERE, 'warm_terms.txt')
        nbytes, t_prefetch = source.prefetch_index()
        t0 = time.monotonic()
        ok, failed = service.warm(load_warm_terms(terms_path))
        t_terms = time.monotonic() - t0
        service.ready = True
        print(f'warm: index {nbytes / 2**20:.1f} MB prefetch {t_prefetch:.2f}s; '
              f'terms ok={ok} failed={failed} in {t_terms:.2f}s', flush=True)
    print(f'ready after {time.monotonic() - t_start:.2f}s', flush=True)
    threading.Event().wait()


if __name__ == '__main__':
    main()
