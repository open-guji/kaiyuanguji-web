"""网站代码「线上是哪一版」的统一读法（overview#470 P1，方案 A）。

两个指针：
  数据指针 latest.json      … webCommitId：数据流程拆出之前由 deploy.yml 写（每次代码发布都改）；
                             拆出之后（开关打开）代码流程不再写它，值会停在最后一次代码发布的版本
  代码指针 web.json          … webCommitId：deploy.yml 在部署成功之后写（#282 起），拆出前后都写
标记：开关打开后的 data.yml 上传会在 latest.json 里加 `"codePointer": "web.json"`。
  · 有标记 ⇒ 以 web.json 为准；web.json 读不到／不合法时退回 latest.json 的值，并在 notes 里写明
  · 无标记 ⇒ 仍以 latest.json.webCommitId 为准（开关没翻前的现行行为；也让回滚到 #282 之前的旧 commit 不会读错，
    因为旧 deploy.yml 只更新 latest.json）
两处 commit 不一致时不悄悄选一个：mismatch 置真，notes 里写出两个值和选了哪个。

同一套规则在四处各有一份实现，改一处要改全部，并跑 ops/tests/test_code_pointer.py 与 code-pointer.test.mjs
（它们用同一张用例表对拍）：本文件、ops/code-pointer.mjs、edge-functions/api/version.js（边缘函数不能 import ops/）、
deploy.yml 的 resolve 里内联的那段 python。
"""
import re

MARKER_KEY = "codePointer"
MARKER_VALUE = "web.json"
_SHA = re.compile(r"^[0-9a-f]{40}$")


def _commit(doc):
    v = doc.get("webCommitId") if isinstance(doc, dict) else None
    return v if isinstance(v, str) and _SHA.match(v) else ""


def resolve(latest, web):
    """latest: 数据指针 dict（读不到给 None 或带 _error 的 dict）；web: 代码指针 dict 或 None。

    返回 {commit, source, marked, mismatch, notes}：
      commit    选中的 40 位 commit，读不到为 ""
      source    "web.json" | "latest.json" | "latest.json（web.json 缺失，退回）"
      marked    latest.json 是否带 codePointer 标记
      mismatch  两处都有合法 commit 且不同 ＝ True，否则 False
      notes     给人看的说明（含两个值）
    """
    marked = isinstance(latest, dict) and latest.get(MARKER_KEY) == MARKER_VALUE
    lc, wc = _commit(latest), _commit(web)
    mismatch = bool(lc and wc and lc != wc)
    notes = []
    if marked:
        if wc:
            commit, source = wc, "web.json"
            if mismatch:
                notes.append(f"latest.json 已标 codePointer：以 web.json 为准（web.json={wc[:12]}，latest.json={lc[:12]}）；"
                             "开关打开后 latest.json 的 webCommitId 不再更新，不一致是正常的")
        else:
            commit, source = lc, "latest.json（web.json 缺失，退回）"
            notes.append("latest.json 已标 codePointer，但 web.json 读不到或不合法，退回 latest.json 的 webCommitId"
                         f"（{lc[:12] or '空'}）——它可能已经过期，核对结果仅供参考")
    else:
        commit, source = lc, "latest.json"
        if mismatch:
            notes.append(f"（参考）web.json={wc[:12]} 与 latest.json={lc[:12]} 不同；latest.json 未标 codePointer，以 latest.json 为准")
    return {"commit": commit, "source": source, "marked": marked, "mismatch": mismatch, "notes": notes}


if __name__ == "__main__":
    # 命令行：python3 ops/code_pointer.py <latest.json 路径> <web.json 路径或 - 表示没有>  → 打印选中的 commit，notes 写到 stderr
    import json
    import sys

    def load(p):
        if p in ("", "-"):
            return None
        try:
            with open(p, encoding="utf-8") as f:
                return json.load(f)
        except Exception:  # noqa: BLE001 —— 读不到就当没有
            return None

    r = resolve(load(sys.argv[1]), load(sys.argv[2]) if len(sys.argv) > 2 else None)
    for n in r["notes"]:
        print(n, file=sys.stderr)
    print(r["commit"])
