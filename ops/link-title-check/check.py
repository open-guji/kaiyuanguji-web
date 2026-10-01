#!/usr/bin/env python3
"""阅读首页链接核对：抓 /read 服务端渲染 HTML，取出站内 /read 链接，
逐个打开取目标页 <title>，繁转简后比对链接上的名字是否出现在 title 里。

只用标准库 + opencc（urllib / html.parser / concurrent.futures）。
"""

import argparse
import concurrent.futures
import json
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from collections import OrderedDict
from html.parser import HTMLParser

try:
    import opencc
except ImportError:  # pragma: no cover
    opencc = None

_CONVERTER = None


def _get_converter():
    global _CONVERTER
    if _CONVERTER is None:
        if opencc is None:
            raise RuntimeError("需要 opencc 包：pip install -r requirements.txt")
        _CONVERTER = opencc.OpenCC("t2s")
    return _CONVERTER


def t2s(text):
    """繁转简（标点原样保留）。"""
    return _get_converter().convert(text)


_WS_RE = re.compile(r"\s+")


def _norm(text):
    return _WS_RE.sub(" ", text).strip()


_VOID_TAGS = {
    "area", "base", "br", "col", "embed", "hr", "img", "input",
    "link", "meta", "param", "source", "track", "wbr",
}


def _classes(attrs):
    return set((attrs.get("class") or "").split())


class _AnchorParser(HTMLParser):
    """抽取每个 <a> 锚点及其内部结构（h3 / bim-rh-t / b / bim-rh-pl /
    span+small / 可见文本），aria-hidden="true" 子树一律忽略。"""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.anchors = []
        self._cur = None  # 当前 <a> 的累积结构
        self._depth = 0

    def _push(self, tag, attrs):
        parent_hidden = any(f["hidden"] for f in self._cur["stack"])
        hidden = parent_hidden or attrs.get("aria-hidden") == "true"
        self._cur["stack"].append({
            "tag": tag,
            "attrs": attrs,
            "classes": _classes(attrs),
            "hidden": hidden,
            "buf": [],
        })

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == "a" and self._cur is None:
            self._cur = {
                "attrs": attrs,
                "classes": _classes(attrs),
                "stack": [],
                "h3": [],
                "t": [],
                "b": [],
                "pl": [],
                "spans": [],  # (hidden, text)
                "has_small": False,
                "text": [],
            }
            self._depth = 1
            return
        if self._cur is None:
            return
        if tag == "a":
            self._depth += 1
        if tag == "small":
            self._cur["has_small"] = True
        if tag in _VOID_TAGS:
            return
        self._push(tag, attrs)

    def handle_startendtag(self, tag, attrs):
        if self._cur is None:
            return
        if tag == "small":
            self._cur["has_small"] = True

    def handle_endtag(self, tag):
        if self._cur is None:
            return
        if tag == "a":
            if self._depth > 1:
                self._depth -= 1
                if self._cur["stack"]:
                    self._pop()
                return
            # 最外层 </a>：收尾
            for frame in self._cur["stack"]:
                self._finish(frame)
            anchors = self.anchors
            cur = self._cur
            self._cur = None
            self._depth = 0
            anchors.append(cur)
            return
        if self._cur["stack"]:
            self._pop()

    def _pop(self):
        frame = self._cur["stack"].pop()
        self._finish(frame)
        return frame

    def _finish(self, frame):
        text = "".join(frame["buf"])
        if frame["tag"] == "h3" and not frame["hidden"]:
            self._cur["h3"].append(text)
        if frame["tag"] == "span" and "bim-rh-t" in frame["classes"] \
                and not frame["hidden"]:
            self._cur["t"].append(text)
        if frame["tag"] == "b" and not frame["hidden"]:
            self._cur["b"].append(text)
        if frame["tag"] == "span" and "bim-rh-pl" in frame["classes"] \
                and not frame["hidden"]:
            self._cur["pl"].append(text)
        if frame["tag"] == "span":
            self._cur["spans"].append((frame["hidden"], text))

    def handle_data(self, data):
        if self._cur is None:
            return
        if any(f["hidden"] for f in self._cur["stack"]):
            return
        for frame in self._cur["stack"]:
            frame["buf"].append(data)
        self._cur["text"].append(data)


def _split_href(href):
    parts = urllib.parse.urlsplit(href)
    qs = dict(urllib.parse.parse_qsl(parts.query))
    return parts.path, qs


def _is_site_read_link(href):
    if not href:
        return False
    if href == "/read" or href.startswith("/read/") or href.startswith("/read?"):
        return True
    return False


def _classify(href, anchor):
    """按规则 1–7 分类，返回 (kind, name)。"""
    path, qs = _split_href(href)
    visible = _norm("".join(anchor["text"]))
    # 1. pk 卡片：名字在 <h3>
    if "bim-rh-pk" in anchor["classes"]:
        names = [_norm(t) for t in anchor["h3"] if _norm(t)]
        return "pk", (names[0] if names else "")
    # 2. 带 span.bim-rh-t 的
    t_names = [_norm(t) for t in anchor["t"] if _norm(t)]
    if t_names:
        return "t", t_names[0]
    # 3. bim-rh-bu-h：名字在 <b>
    if "bim-rh-bu-h" in anchor["classes"]:
        names = [_norm(t) for t in anchor["b"] if _norm(t)]
        return "bu-h", (names[0] if names else "")
    # 4. 时期链接 /read?period=…：名字在 span.bim-rh-pl
    if path == "/read" and "period" in qs:
        names = [_norm(t) for t in anchor["pl"] if _norm(t)]
        return "period", (names[0] if names else "")
    # 5. 分类链接 /read?node=… 且含 span+small：第一个非隐藏 span
    if path == "/read" and "node" in qs and anchor["has_small"]:
        for hidden, text in anchor["spans"]:
            if not hidden and _norm(text):
                return "node-span", _norm(text)
        return "node-span", ""
    # 7 (先于纯文本判定). 导航链接：文字以 → 结尾，只要求 200
    if visible.endswith("→"):
        return "nav", visible
    # 6. 纯文字链接：名字就是整段文字
    return "plain", visible


def extract_links(html, dedup=True):
    """从 /read 首页 HTML 抽取站内链接。

    返回 [{"href", "name", "kind"}]，kind 为 pk / t / bu-h /
    period / node-span / plain / nav。跳过指向 /read 自身的链接；
    dedup=True 时按 href 去重保留首个。
    """
    parser = _AnchorParser()
    parser.feed(html)
    out = []
    for anchor in parser.anchors:
        href = (anchor["attrs"].get("href") or "").strip()
        if not _is_site_read_link(href):
            continue
        if href == "/read":
            continue
        kind, name = _classify(href, anchor)
        out.append({"href": href, "name": name, "kind": kind})
    if not dedup:
        return out
    uniq = OrderedDict()
    for item in out:
        uniq.setdefault(item["href"], item)
    return list(uniq.values())


class _TitleParser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self._in_title = False
        self._done = False
        self.parts = []

    def handle_starttag(self, tag, attrs):
        if tag == "title" and not self._done:
            self._in_title = True

    def handle_endtag(self, tag):
        if tag == "title" and self._in_title:
            self._in_title = False
            self._done = True

    def handle_data(self, data):
        if self._in_title and not self._done:
            self.parts.append(data)


def extract_title(html):
    """取目标页 <title> 文本（去首尾空白，实体已解码）；没有则 None。"""
    if not html:
        return None
    parser = _TitleParser()
    parser.feed(html)
    if not parser._done and not parser.parts:
        return None
    return _norm("".join(parser.parts))


def judge(name, status, title, kind=None):
    """判定单条链接。返回 (ok, reason)。

    规则：先过 status（None/0 为“请求失败”，非 200 为“HTTP xxx”）；
    之后只有 nav 类只看 200（kind 为 None 时按名字是否以 → 结尾判断）；
    其他 kind 名字为空记不符“未抽到名字”；否则 200 且
    t2s(name) in t2s(title) 为对，否则“title 不含名字”。
    """
    if status is None or status == 0:
        return False, "请求失败"
    if status != 200:
        return False, "HTTP %s" % status
    norm_name = _norm(t2s(name)) if name else ""
    is_nav = (kind == "nav") if kind is not None else norm_name.endswith("→")
    if is_nav:
        return True, "OK"
    if not norm_name:
        return False, "未抽到名字"
    norm_title = _norm(t2s(title)) if title else ""
    if norm_title and norm_name in norm_title:
        return True, "OK"
    return False, "title 不含名字"


def fetch_page(url, timeout=20):
    """抓取单个页面。返回 (status, html)，失败时 status 为 None。

    HTTP 错误状态（404/500 等）正常返回 (code, body)；连接失败、
    超时等返回 (None, None)。
    """
    req = urllib.request.Request(url, headers={
        "User-Agent": "kaiyuanguji-link-title-check/1.0",
        "cache-control": "no-cache",
        "Accept": "text/html,application/xhtml+xml",
    })
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read()
            charset = resp.headers.get_content_charset() or "utf-8"
            try:
                page = raw.decode(charset, errors="replace")
            except LookupError:
                page = raw.decode("utf-8", errors="replace")
            return resp.status, page
    except urllib.error.HTTPError as exc:
        try:
            raw = exc.read()
            charset = (exc.headers.get_content_charset()
                       if exc.headers else None) or "utf-8"
            page = raw.decode(charset, errors="replace")
        except Exception:
            page = None
        return exc.code, page
    except Exception:
        return None, None


def run_check(base, pages, fetch=fetch_page, concurrency=4, timeout=20):
    """主流程（便于测试时替换 fetch）。返回记录 list，每条含
    source_page, href, name, kind, status, title, ok, reason。"""
    base = base.rstrip("/")
    jobs = []
    for page in pages:
        source_url = base + page
        status, html = fetch(source_url, timeout)
        if status != 200 or not html:
            raise RuntimeError("抓取 %s 失败：%s"
                               % (source_url,
                                  "请求失败" if status in (None, 0)
                                  else "HTTP %s" % status))
        for link in extract_links(html):
            jobs.append((page, link))

    records = [None] * len(jobs)

    def _one(index):
        source_page, link = jobs[index]
        url = urllib.parse.urljoin(base + "/", link["href"].lstrip("/"))
        status, html = fetch(url, timeout)
        title = extract_title(html) if html else None
        ok, reason = judge(link["name"], status, title, link["kind"])
        return {
            "source_page": source_page,
            "href": link["href"],
            "name": link["name"],
            "kind": link["kind"],
            "status": status,
            "title": title,
            "ok": ok,
            "reason": reason,
        }

    workers = max(1, concurrency)
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
        future_map = {pool.submit(_one, i): i for i in range(len(jobs))}
        for future in concurrent.futures.as_completed(future_map):
            records[future_map[future]] = future.result()
    return records


def main(argv=None, fetch=fetch_page):
    parser = argparse.ArgumentParser(description="核对阅读首页站内链接的书名与目标页 title")
    parser.add_argument("--base", default="https://staging.kaiyuanguji.com")
    parser.add_argument("--pages", nargs="*", default=["/read"])
    parser.add_argument("--concurrency", type=int, default=4)
    parser.add_argument("--timeout", type=int, default=20)
    parser.add_argument("--out", default=None)
    args = parser.parse_args(argv)

    try:
        records = run_check(args.base, args.pages, fetch=fetch,
                            concurrency=args.concurrency,
                            timeout=args.timeout)
    except RuntimeError as exc:
        print("错误：%s" % exc, file=sys.stderr)
        return 1

    bad = [r for r in records if not r["ok"]]
    print("核对 %d 个链接，不符 %d 个" % (len(records), len(bad)))
    for item in bad:
        print("- [%s] %s %s -> %s（title：%s）"
              % (item["kind"], item["name"], item["href"],
                 item["reason"], item["title"]))

    if args.out:
        with open(args.out, "w", encoding="utf-8") as fh:
            json.dump(records, fh, ensure_ascii=False, indent=2)

    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
