#!/usr/bin/env python3
"""回滚后核对（DBG）：线上真的是目标 web commit 了吗。只读。

  python3 ops/rollback-check.py --site staging --web <40 位 sha> [--pointer] [--timeout 600]

--pointer：同时要求数据指针（staging/latest.json 或 latest.json）的 webCommitId ＝ 目标；
          代码指针 web.json 只打印对比（过渡期可能落后），不参与判定
          （promote 会写它）。
/api/version：目标 commit 有这个接口时 web 必须＝目标；没有（早于 DBG）则只看指针。
在超时内每 20 秒重试一次（CDN 传播要时间），超时仍不对就非零退出。
"""
import argparse
import json
import sys
import time
import urllib.request

SITES = {"production": "https://www.kaiyuanguji.com", "staging": "https://staging.kaiyuanguji.com",
         "ssr-test": "https://ssr-test.kaiyuanguji.com"}
POINTERS = {"production": "https://data.kaiyuanguji.com/latest.json",
            "staging": "https://data.kaiyuanguji.com/staging/latest.json",
            "ssr-test": "https://data.kaiyuanguji.com/latest.json"}
# overview#470 P1：代码指针 web.json（部署成功后写）。过渡期只作参考、不参与判定：
# 晋升（promote）读的是 latest.json 的 webCommitId，回滚到早于 P1 的旧 commit 时旧 deploy.yml 也只更新 latest.json，
# web.json 会落后——若让它也能「通过」，会出现核对绿了、晋升却读到另一个 commit。
WEB_POINTERS = {"production": "https://data.kaiyuanguji.com/web.json",
                "staging": "https://data.kaiyuanguji.com/staging/web.json",
                "ssr-test": "https://data.kaiyuanguji.com/web.json"}


def get_json(url):
    try:
        req = urllib.request.Request(f"{url}?cb={int(time.time() * 1000)}", headers={"Cache-Control": "no-cache"})
        with urllib.request.urlopen(req, timeout=20) as r:
            return r.status, json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        return e.code, None
    except Exception as e:  # noqa: BLE001
        return None, {"_error": str(e)}


def check_once(site, web, pointer, want_version):
    problems = []
    if pointer:
        _, p = get_json(POINTERS[site])
        got = (p or {}).get("webCommitId")
        if got != web:
            problems.append(f"数据指针 webCommitId={got!r}，期望 {web[:12]}")
        _, w = get_json(WEB_POINTERS[site])
        got_web = (w or {}).get("webCommitId")
        if got_web and got_web != web:
            print(f"  （参考）代码指针 web.json webCommitId={got_web[:12]}，与目标不同——过渡期它可能落后，不影响判定")
    if want_version:
        st, v = get_json(f"{SITES[site]}/api/version")
        got = (v or {}).get("web")
        if st != 200 or got != web:
            problems.append(f"/api/version HTTP {st} web={got!r}，期望 {web[:12]}")
        else:
            print(f"  /api/version：web={got[:12]} target={v.get('target')} data={v.get('data')} builtAt={v.get('builtAt')}")
    return problems


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--site", choices=list(SITES), required=True)
    ap.add_argument("--web", required=True)
    ap.add_argument("--pointer", action="store_true")
    ap.add_argument("--version-endpoint", choices=["true", "false"], default="true")
    ap.add_argument("--timeout", type=int, default=600)
    a = ap.parse_args()
    want_version = a.version_endpoint == "true"
    if not a.pointer and not want_version:
        sys.exit("❌ 既不查指针也不查 /api/version，无从核对")
    deadline = time.time() + a.timeout
    while True:
        problems = check_once(a.site, a.web, a.pointer, want_version)
        if not problems:
            print(f"✓ {a.site} 已是 {a.web[:12]}")
            return
        if time.time() >= deadline:
            for p in problems:
                print(f"❌ {p}")
            sys.exit(1)
        print(f"· 还不对（{'；'.join(problems)}），20 秒后重试")
        time.sleep(20)


if __name__ == "__main__":
    main()
