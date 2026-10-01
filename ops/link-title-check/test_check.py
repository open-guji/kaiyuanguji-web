"""check.py 的 pytest（不联网：只读本地 fixture，网络函数用假实现替换）。"""

import json
from collections import Counter

import pytest

import check
from check import extract_links, extract_title, judge


FIXTURE = "fixtures/read-home.html"


def _fixture_html():
    with open(FIXTURE, encoding="utf-8") as fh:
        return fh.read()


def test_extract_links_total_and_kinds():
    links = extract_links(_fixture_html())
    assert len(links) == 145
    assert Counter(l["kind"] for l in links) == {
        "pk": 6,
        "t": 70,
        "bu-h": 4,
        "node-span": 23,
        "nav": 1,
        "period": 9,
        "plain": 32,
    }


def test_extract_links_raw_counts_match_fixture():
    # 去重前：与抓取到的锚点一一对应（另有 1 个指向 /read 自身的被跳过，
    # 8 个重复 href 的二次出现去重时被合并）
    links = extract_links(_fixture_html(), dedup=False)
    assert len(links) == 153
    assert Counter(l["kind"] for l in links) == {
        "pk": 6,
        "t": 75,
        "bu-h": 4,
        "node-span": 23,
        "nav": 4,
        "period": 9,
        "plain": 32,
    }


def test_extract_links_spot_names():
    by_href = {l["href"]: l for l in extract_links(_fixture_html())}
    assert by_href["/read/d59f23o7ygw2"]["name"] == "汉书·艺文志"
    assert by_href["/read/d59f23o7ygw2"]["kind"] == "pk"
    assert by_href["/read?period=song"] == {
        "href": "/read?period=song", "name": "宋", "kind": "period",
    }
    assert by_href["/read/96kzii6z28"]["name"] == "脂砚斋重评石头记"
    assert by_href["/read/d59f2hp7qpz6"]["name"] == "安国寺大悲阁记"
    assert by_href["/read/d59f2hp7qpz6"]["kind"] == "plain"
    assert by_href["/read?node=cc897679fd3"]["name"] == "经部"
    assert by_href["/read?node=unclassified"]["kind"] == "nav"
    # 重复 href 只保留首次出现（pk 卡片在 t 条目之前）
    assert by_href["/read/d59f2870u874"]["kind"] == "pk"
    # 指向 /read 自身的链接被跳过
    assert "/read" not in by_href


def test_extract_title_normal():
    html = ("<html><head><title>漢書·藝文志 · 總序 · 整理本 - 开源古籍"
            "</title></head><body></body></html>")
    assert extract_title(html) == "漢書·藝文志 · 總序 · 整理本 - 开源古籍"


def test_extract_title_missing():
    assert extract_title("<html><head></head><body>无标题</body></html>") is None


def test_extract_title_entity():
    assert extract_title("<html><head><title>诗 &amp; 酒</title></head></html>") == "诗 & 酒"


def test_judge_traditional_matches_simplified():
    ok, _ = judge("汉书·艺文志", 200, "漢書·藝文志 · 總序 · 整理本 - 开源古籍")
    assert ok


def test_judge_non_200():
    ok, reason = judge("汉书·艺文志", 404, "whatever")
    assert not ok and reason == "HTTP 404"


def test_judge_title_mismatch():
    ok, reason = judge("汉书·艺文志", 200, "宋 - 阅读 - 开源古籍")
    assert not ok and reason == "title 不含名字"


def test_judge_nav_only_needs_200():
    ok, _ = judge("经部全部 10 类 →", 200, "毫不相干的标题")
    assert ok
    ok, reason = judge("经部全部 10 类 →", 404, "经部全部 10 类 →")
    assert not ok and reason == "HTTP 404"


def test_judge_request_failure():
    ok, reason = judge("宋", None, None)
    assert not ok and reason == "请求失败"


def test_judge_empty_name_non_nav():
    ok, reason = judge("", 200, "宋 - 阅读 - 开源古籍")
    assert not ok and reason == "未抽到名字"
    ok, reason = judge("", 200, "宋 - 阅读 - 开源古籍", kind="plain")
    assert not ok and reason == "未抽到名字"
    # 非 200 优先报状态
    ok, reason = judge("", 404, None, kind="t")
    assert not ok and reason == "HTTP 404"
    ok, reason = judge("", None, None, kind="t")
    assert not ok and reason == "请求失败"


def test_judge_nav_empty_name_with_kind():
    ok, _ = judge("", 200, None, kind="nav")
    assert ok


def _fake_fetch_factory(fixture_html, bad_status_href=None,
                        bad_title_href=None):
    by_href = {l["href"]: l for l in extract_links(fixture_html)}

    def fake_fetch(url, timeout=20):
        # run_check 用 urljoin(base + "/", href) 拼目标 URL
        href = url[len("http://example.test"):]
        if href == "/read":
            return 200, fixture_html
        if href == bad_status_href:
            return 404, "<html><head><title>404</title></head></html>"
        if href == bad_title_href:
            return 200, "<html><head><title>风马牛不相及</title></head></html>"
        name = by_href[href]["name"]
        return 200, "<html><head><title>%s · 后缀 - 开源古籍</title></head></html>" % name

    return fake_fetch


def test_main_flow_mismatches_and_exit_code(capsys):
    fixture_html = _fixture_html()
    fetch = _fake_fetch_factory(
        fixture_html,
        bad_status_href="/read/d59f2hp7qpz6",
        bad_title_href="/read?period=song",
    )
    code = check.main(
        ["--base", "http://example.test", "--pages", "/read",
         "--concurrency", "4", "--timeout", "20"],
        fetch=fetch,
    )
    out = capsys.readouterr().out
    assert code == 1
    assert "核对 145 个链接，不符 2 个" in out
    assert "/read/d59f2hp7qpz6" in out and "HTTP 404" in out
    assert "/read?period=song" in out and "title 不含名字" in out


def test_main_flow_all_ok_and_out_json(capsys, tmp_path):
    fixture_html = _fixture_html()
    out_file = str(tmp_path / "out.json")
    code = check.main(
        ["--base", "http://example.test", "--out", out_file],
        fetch=_fake_fetch_factory(fixture_html),
    )
    out = capsys.readouterr().out
    assert code == 0
    assert "核对 145 个链接，不符 0 个" in out
    with open(out_file, encoding="utf-8") as fh:
        records = json.load(fh)
    assert len(records) == 145
    assert all(r["ok"] for r in records)
    assert set(records[0]) == {
        "source_page", "href", "name", "kind",
        "status", "title", "ok", "reason",
    }
