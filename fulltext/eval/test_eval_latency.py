"""eval_latency 统计函数单元测试（不起服务，纯函数）。运行：python3 -m pytest eval/test_eval_latency.py -q"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import eval_latency as el  # noqa: E402


def test_percentile_linear_interpolation_matches_numpy_default():
    xs = [10, 20, 30, 40, 50]
    assert el.percentile(xs, 0) == 10
    assert el.percentile(xs, 50) == 30
    assert el.percentile(xs, 100) == 50
    # k = 4 * 0.9 = 3.6 → 40 + 0.6 * 10
    assert abs(el.percentile(xs, 90) - 46.0) < 1e-9
    # 乱序输入不影响结果
    assert el.percentile([50, 10, 40, 20, 30], 50) == 30


def test_percentile_empty_and_single():
    assert el.percentile([], 50) is None
    assert el.percentile([7.5], 99) == 7.5


def test_summarize_counts_timeouts_and_errors_and_uses_only_200_for_latency():
    records = [
        (10.0, 200),
        (20.0, 200),
        (30.0, 200),
        (9999.0, 504),  # 超时：计数，不进分位数
        (5.0, 503),     # 忙：算错误
        (5.0, None),    # 网络异常：算错误
    ]
    s = el.summarize(records)
    assert s['n'] == 6
    assert s['timeouts'] == 1
    assert s['errors'] == 2
    assert s['max'] == 30.0
    assert s['p50'] == 20.0
    assert s['p90'] == 28.0  # k = 2 * 0.9 = 1.8 → 20 + 0.8 * 10
    assert abs(s['p95'] - 29.0) < 1e-9  # k = 2 * 0.95 = 1.9 → 20 + 0.9 * 10


def test_summarize_all_failed_gives_none_latency():
    s = el.summarize([(1.0, 503), (2.0, None)])
    assert s['p50'] is None and s['max'] is None
    assert s['errors'] == 2


def test_split_cold_hot_first_pass_is_cold_and_warmup_discarded():
    # 3 条查询，第 1 遍为冷，之后每遍都是热；热序列丢弃前 DISCARD_WARMUP 条
    n_warm = el.DISCARD_WARMUP
    seq = [('a', 1.0, 200), ('b', 2.0, 200), ('c', 3.0, 200)]
    for i in range(n_warm + 5):
        q = 'abc'[i % 3]
        seq.append((q, 100.0 + i, 200))
    cold, hot = el.split_cold_hot(seq, 3)
    assert [lat for lat, _ in cold] == [1.0, 2.0, 3.0]
    assert len(hot) == 5
    assert hot[0][0] == 100.0 + n_warm  # 前 n_warm 条已丢弃


def test_split_cold_hot_duplicate_query_strings_keep_cold_count():
    # 查询串重复（如 queries 里两次出现的「莊子」）：冷档仍按位置取满 n_queries 条
    seq = [('莊子', 1.0, 200), ('莊子', 2.0, 200), ('孔子', 3.0, 200)]
    cold, hot = el.split_cold_hot(seq, 3)
    assert [lat for lat, _ in cold] == [1.0, 2.0, 3.0]
    assert hot == []


def test_split_cold_hot_too_few_hot_gives_empty_hot():
    cold, hot = el.split_cold_hot([('a', 1.0, 200), ('a', 2.0, 200)], 1)
    assert cold == [(1.0, 200)]
    assert hot == []


def test_summarize_error_types_and_client_timeout_counted_separately():
    s = el.summarize([(1.0, 200), (5000.0, 'timeout'), (5.0, 'exc:URLError'), (5.0, 503), (5.0, 504)])
    assert s['timeouts'] == 2  # 客户端超时 + 504
    assert s['errors'] == 2
    assert s['error_types'] == {'exc:URLError': 1, '503': 1}


def test_build_url_encodes_chinese_and_fixed_params():
    url = el.build_url('http://h:1/', '孔子', 'fuzzy')
    assert url.startswith('http://h:1/api/fulltext?')
    assert 'group=book' in url and 'limit=10' in url and 'mode=fuzzy' in url  # 默认验收口径
    assert 'group=none' in el.build_url('http://h:1/', '孔子', 'fuzzy', group='none')
    assert '孔' not in url  # 必须是百分号编码


def test_tier_labels_name_lru_and_os_cache_state_separately():
    cold = el.tier_labels('cold', 'on')
    assert cold['cold'] == '冷档：服务进程 LRU 冷 + OS 页缓存冷'
    assert cold['hot'] == '热档：服务进程 LRU 热 + OS 页缓存冷'
    warm = el.tier_labels('warm', 'off')
    assert warm['cold'] == '冷档：服务进程 LRU 冷 + OS 页缓存暖'
    assert (warm['os_page_cache'], warm['service_warm']) == ('warm', 'off')


def test_tier_labels_reject_unknown_values():
    import pytest
    with pytest.raises(ValueError):
        el.tier_labels('frozen', 'on')
