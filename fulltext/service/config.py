"""检索服务配置。全部来自环境变量，默认值与分块-F4 一致。"""
import os
from dataclasses import dataclass


@dataclass(frozen=True)
class Config:
    host: str = '127.0.0.1'        # 只监听本机；公网经 EdgeOne 反代，F5 白名单只放 /api/fulltext
    port: int = 8765
    index_dir: str = ''            # 索引目录（F2 产出）；步 1 未接入
    text_root: str = ''            # book-text 根目录，读章 md 回映命中
    candidates: int = 400          # 候选段上限；0 = 不截断（评测模式，FT_CANDIDATES=0）
    max_concurrent: int = 4        # 全局并发闸（步 3）
    queue_max: int = 8             # 排队上限，超出 503 busy（步 3）
    timeout_s: float = 3.0         # 不再等待的时限；Tantivy 查询无法中断（步 3）
    lru_bytes: int = 64 * 1024 * 1024  # 章 md 缓存字节上限（步 3）
    warm: bool = True              # 启动预热：预读索引 + 高频词（FT_WARM=0 关闭）
    warm_terms: str = ''           # 预热词表，空 = service/warm_terms.txt


def load(env=None) -> Config:
    e = os.environ if env is None else env
    d = Config()
    return Config(
        host=e.get('FT_HOST', d.host),
        port=int(e.get('FT_PORT', d.port)),
        index_dir=e.get('FT_INDEX_DIR', d.index_dir),
        text_root=e.get('FT_TEXT_ROOT', d.text_root),
        candidates=int(e.get('FT_CANDIDATES', d.candidates)),
        max_concurrent=int(e.get('FT_MAX_CONCURRENT', d.max_concurrent)),
        queue_max=int(e.get('FT_QUEUE_MAX', d.queue_max)),
        timeout_s=float(e.get('FT_TIMEOUT_S', d.timeout_s)),
        lru_bytes=int(e.get('FT_LRU_BYTES', d.lru_bytes)),
        warm=e.get('FT_WARM', '1' if d.warm else '0') not in ('0', '', 'false', 'off'),
        warm_terms=e.get('FT_WARM_TERMS', d.warm_terms),
    )
