#!/usr/bin/env python3
"""「下载本冊」对照测试的标准答案：用 book-text 的 Python 生成器出各小样本的正文。

    python3 nextjs/scripts/export-golden.py --book-text ../book-text

读 nextjs/src/lib/export/__tests__/cases/*/input.json，在同目录写：
    lines.md   分行本         render_lines(char, fig)
    works.md   标点本         render_rich，只留 work 实体并去 href（只出书名号）
    plain.md   专名本不带链接  render_rich，实体去 href
    linked.md  专名本带链接    render_rich
有 fig 的样本另出 *.nofig.md（不给 fig.json 时的写法）。

网站的 guji-md.ts 与这些文件逐字节比对（cases.test.ts）。改了生成规则要两边一起改，
再跑本脚本更新答案，并在 PR 里看 .md 的改动是否都是预期的。
"""
import argparse
import copy
import json
import sys
from pathlib import Path

CASES = Path(__file__).resolve().parent.parent / "src/lib/export/__tests__/cases"


def strip_href(entity):
    e = copy.deepcopy(entity)
    for it in e.get("entities") or []:
        (it.get("target") or {}).pop("href", None)
    return e


def works_only(entity):
    e = strip_href(entity)
    e["entities"] = [it for it in e.get("entities") or [] if it["type"] == "work"]
    return e


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--book-text", required=True, help="book-text 仓的检出目录")
    args = ap.parse_args()
    sys.path.insert(0, str(Path(args.book_text) / "scripts/book-text"))
    from original_char import render_lines, render_rich  # noqa: E402

    for d in sorted(p for p in CASES.iterdir() if p.is_dir()):
        x = json.loads((d / "input.json").read_text(encoding="utf-8"))
        char, punct, entity = x["char"], x.get("punct"), x.get("entity") or {}
        variants = [("", x.get("fig"))] + ([(".nofig", None)] if "fig" in x else [])
        for suffix, fig in variants:
            out = {
                "lines": render_lines(char, fig),
                "works": render_rich(char, punct, works_only(entity), fig),
                "plain": render_rich(char, punct, strip_href(entity), fig),
                "linked": render_rich(char, punct, entity, fig),
            }
            for k, v in out.items():
                (d / f"{k}{suffix}.md").write_text(v, encoding="utf-8")
        print(d.name)


if __name__ == "__main__":
    main()
