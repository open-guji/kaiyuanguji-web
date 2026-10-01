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
    assert "核对 145 个链接，不符 2 个，重试后才成功 0 个" in out
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
    assert "核对 145 个链接，不符 0 个，重试后才成功 0 个" in out
    with open(out_file, encoding="utf-8") as fh:
        records = json.load(fh)
    assert len(records) == 145
    assert all(r["ok"] for r in records)
    assert set(records[0]) == {
        "source_page", "href", "name", "kind",
        "status", "title", "ok", "reason",
        "attempts", "retried_ok",
    }
    assert all(r["attempts"] == 1 and r["retried_ok"] is False
               for r in records)


META_FIXTURE = "fixtures/meta-home-sections.json"


def _meta_sections():
    with open(META_FIXTURE, encoding="utf-8") as fh:
        return json.load(fh)


def test_extract_meta_entries_counts():
    entries = check.extract_meta_entries(_meta_sections())
    assert len(entries) == 96
    assert Counter(e["zone"] for e in entries) == {
        "shelf": 28,
        "related_catalogs": 14,
        "catalog_progress": 10,
        "collection_groups": 28,
        "bibliographers": 11,
        "lineage": 5,
    }
    # 不去重：按 id 去重后应为 86 个
    assert len({e["id"] for e in entries}) == 86


def test_extract_meta_entries_spot():
    entries = check.extract_meta_entries(_meta_sections())
    cp = [e for e in entries
          if e["zone"] == "catalog_progress" and e["id"] == "d59dh3vo9af4"]
    assert len(cp) == 1 and cp[0]["name"] == "欽定四庫全書總目"
    bib = [e for e in entries if e["zone"] == "bibliographers"]
    assert bib[0]["name"] == "劉向" and bib[0]["id"] == "hixhd2f8waju"
    # catalog_progress 取 work_id 而非条目自身的 id
    assert all(e["id"] != "siku-zongmu" for e in entries)


def test_judge_meta_mode():
    ok, _ = judge("劉向", 200, "劉向（西漢） - 开源古籍",
                  kind="bibliographers", mode="meta")
    assert ok
    # 名字无「·」，title 有「·」：meta 归一化后对得上
    ok, _ = judge("漢書藝文志", 200, "漢書·藝文志 - 开源古籍",
                  kind="catalog_progress", mode="meta")
    assert ok
    ok, reason = judge("漢書藝文志", 200, "宋史藝文志 - 开源古籍",
                       kind="catalog_progress", mode="meta")
    assert not ok and reason == "title 不含名字"


def test_judge_read_mode_keeps_dot():
    # 阅读模式保留「·」：无点的名字对不上带点的 title
    ok, _ = judge("漢書藝文志", 200, "漢書·藝文志 - 开源古籍")
    assert not ok


def _scripted_fetch(script, calls=None):
    state = {url: list(seq) for url, seq in script.items()}

    def fake(url, timeout=20):
        if calls is not None:
            calls.append(url)
        seq = state.get(url)
        if seq:
            return seq.pop(0)
        return 200, "<html><head><title>默认</title></head></html>"

    return fake


def test_fetch_with_retry_success_after_503s():
    sleeps = []
    fetch = _scripted_fetch({
        "http://x/a": [(503, "busy"), (503, "busy"),
                       (200, "<title>t</title>")],
    })
    status, _, attempts, retried_ok = check.fetch_with_retry(
        fetch, "http://x/a", sleep=sleeps.append)
    assert (status, attempts, retried_ok) == (200, 3, True)
    assert sleeps == [3, 3]


def test_fetch_with_retry_gives_up_after_2_retries():
    fetch = _scripted_fetch({"http://x/a": [(503, "busy")] * 3})
    status, _, attempts, retried_ok = check.fetch_with_retry(
        fetch, "http://x/a", sleep=lambda s: None)
    assert status == 503 and attempts == 3 and retried_ok is False


def test_fetch_with_retry_no_retry_on_404():
    calls = []
    fetch = _scripted_fetch(
        {"http://x/a": [(404, "nf"), (200, "late")]}, calls=calls)
    status, _, attempts, retried_ok = check.fetch_with_retry(
        fetch, "http://x/a", sleep=lambda s: None)
    assert (status, attempts, retried_ok) == (404, 1, False)
    assert calls == ["http://x/a"]


def test_fetch_with_retry_timeout_like_503():
    fetch = _scripted_fetch({
        "http://x/a": [(None, None), (None, None),
                       (200, "<title>t</title>")],
    })
    status, _, attempts, retried_ok = check.fetch_with_retry(
        fetch, "http://x/a", sleep=lambda s: None)
    assert (status, attempts, retried_ok) == (200, 3, True)


def _meta_fake_fetch(sections, flaky_id, bad_id, requested=None):
    base, data = "http://example.test", "http://data.test"
    # 同一 id 取最长名字拼 title（如「欽定四庫全書·文淵閣本」），
    # 短名字（「欽定四庫全書」）作为子串同样对得上
    by_id = {}
    for entry in check.extract_meta_entries(sections):
        prev = by_id.get(entry["id"])
        if prev is None or len(entry["name"]) > len(prev["name"]):
            by_id[entry["id"]] = entry
    seen = {}

    def fake(url, timeout=20):
        if requested is not None:
            requested.append(url)
        if url == data + "/latest.json":
            return 200, '{"cacheKey": "testkey123"}'
        if url == data + "/current/meta-home/sections.json?v=testkey123":
            return 200, json.dumps(sections, ensure_ascii=False)
        assert url.startswith(base + "/item/")
        iid = url[len(base + "/item/"):]
        if iid == bad_id:
            return 200, "<html><head><title>风马牛不相及</title></head></html>"
        if iid == flaky_id:
            n = seen.get(url, 0)
            seen[url] = n + 1
            if n == 0:
                return 503, "busy"
        name = by_id[iid]["name"]
        return 200, ("<html><head><title>%s - 开源古籍</title></head>"
                     "</html>") % name

    return fake


def test_meta_flow(capsys, tmp_path):
    sections = _meta_sections()
    entries = check.extract_meta_entries(sections)
    counts = Counter(e["id"] for e in entries)
    singles = [iid for iid, n in counts.items() if n == 1]
    flaky_id, bad_id = singles[0], singles[1]
    requested = []
    out_file = str(tmp_path / "meta.json")
    code = check.main(
        ["--base", "http://example.test", "--data", "http://data.test",
         "--meta-home", "--out", out_file],
        fetch=_meta_fake_fetch(sections, flaky_id, bad_id, requested),
        sleep=lambda s: None,
    )
    out = capsys.readouterr().out
    assert code == 1
    assert "核对 96 个链接，不符 1 个，重试后才成功 1 个" in out
    assert bad_id in out and "title 不含名字" in out
    # sections.json 带 cacheKey 查询参数
    assert ("http://data.test/current/meta-home/sections.json?v=testkey123"
            in requested)
    # 同一 URL 只请求一次（96 条、86 个去重 URL）
    item_urls = [u for u in requested if "/item/" in u]
    assert len(set(item_urls)) == 86
    with open(out_file, encoding="utf-8") as fh:
        records = json.load(fh)
    assert len(records) == 96
    assert all(r["source_page"].startswith("meta-home:") for r in records)
    assert {r["kind"] for r in records} == set(check.META_ZONES)
    flaky = [r for r in records if r["href"] == "/item/" + flaky_id]
    assert len(flaky) == 1 and flaky[0]["ok"]
    assert flaky[0]["attempts"] == 2 and flaky[0]["retried_ok"] is True
    bad = [r for r in records if r["href"] == "/item/" + bad_id]
    assert len(bad) == 1 and not bad[0]["ok"]


def test_meta_cachekey_fallback_to_commit_id():
    requested = []

    def fake(url, timeout=20):
        requested.append(url)
        if url.endswith("/latest.json"):
            return 200, '{"commitId": "c9"}'
        if url.endswith("sections.json?v=c9"):
            return 200, '{"shelf": {"items": []}}'
        raise AssertionError(url)

    records = check.run_meta_check(
        "http://example.test", "http://data.test",
        fetch=fake, sleep=lambda s: None)
    assert records == []
    assert any(u.endswith("sections.json?v=c9") for u in requested)


def test_read_homepage_retries_then_ok(capsys):
    fixture_html = _fixture_html()
    state = {"n": 0}
    base_fetch = _fake_fetch_factory(fixture_html)

    def fake(url, timeout=20):
        if url == "http://example.test/read":
            state["n"] += 1
            if state["n"] == 1:
                return None, None
        return base_fetch(url, timeout)

    code = check.main(["--base", "http://example.test"],
                      fetch=fake, sleep=lambda s: None)
    out = capsys.readouterr().out
    assert code == 0
    assert "核对 145 个链接，不符 0 个，重试后才成功 0 个" in out
    assert state["n"] == 2


def test_read_homepage_failure_exits_1(capsys):
    def fake(url, timeout=20):
        return None, None

    code = check.main(["--base", "http://example.test"],
                      fetch=fake, sleep=lambda s: None)
    assert code == 1
    assert "错误" in capsys.readouterr().err
