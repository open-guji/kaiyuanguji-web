"""检索服务配置。全部来自环境变量。"""
import os
from dataclasses import dataclass


@dataclass(frozen=True)
class Config:
    host: str = '127.0.0.1'        # 默认只监听本机；对公网开放时设 0.0.0.0 并配 edge_token
    port: int = 8765
    index_dir: str = ''            # 索引目录（build_pack 产出的 index/）
    titles: str = ''               # titles.json（书 ID → 书名）
    boost: str = ''                # boost.json（可选，书 ID → 倍数）
    exact_scan: int = 3000         # exact 模式最多扫的候选段数
    max_concurrent: int = 4        # 全局并发闸（步 3）
    queue_max: int = 8             # 排队上限，超出 503 busy（步 3）
    timeout_s: float = 3.0         # 不再等待的时限；Tantivy 查询无法中断（步 3）
    warm: bool = True              # 启动预热：预读索引 + 高频词（FT_WARM=0 关闭）
    warm_terms: str = ''           # 预热词表，空 = service/warm_terms.txt
    edge_token: str = ''           # 非本机来源须带 X-FT-Token 等于它（EdgeOne 边缘函数）；空＝非本机一律 404


def load(env=None) -> Config:
    e = os.environ if env is None else env
    d = Config()
    return Config(
        host=e.get('FT_HOST', d.host),
        port=int(e.get('FT_PORT', d.port)),
        index_dir=e.get('FT_INDEX_DIR', d.index_dir),
        titles=e.get('FT_TITLES', d.titles),
        boost=e.get('FT_BOOST', d.boost),
        exact_scan=int(e.get('FT_EXACT_SCAN', d.exact_scan)),
        max_concurrent=int(e.get('FT_MAX_CONCURRENT', d.max_concurrent)),
        queue_max=int(e.get('FT_QUEUE_MAX', d.queue_max)),
        timeout_s=float(e.get('FT_TIMEOUT_S', d.timeout_s)),
        warm=e.get('FT_WARM', '1' if d.warm else '0') not in ('0', '', 'false', 'off'),
        warm_terms=e.get('FT_WARM_TERMS', d.warm_terms),
        edge_token=e.get('FT_EDGE_TOKEN', d.edge_token),
    )
