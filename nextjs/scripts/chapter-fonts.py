#!/usr/bin/env python3
"""
chapter-fonts.py — 对读章的生僻字子集字体（GUJI-701，由 scripts/lib/chapter-fonts.mjs 调用，不单独跑）。

网站的扩展区汉字兜底是花园明朝（globals.css 的 HANAMIN 段，按 unicode-range 分片，每片约 200KB）。
一章几十个生僻字散在十几片里，读者要下 3～4MB。这里把一章用到的字从各分片里抽出来合成一个 woff2（约 10KB），
阅读页服务端渲染时追加一条同字族的 @font-face（后定义的先查），这些字就不再去取大分片。

输入（stdin，JSON）：
  { "hanamin": "<hanamin@0.0.5 包目录，含 HanaMin.css 与各分片 woff2>",
    "jobs": [ { "out": "<输出 woff2 路径>", "cps": [码位, …] } ] }
  cps 由调用方按 globals.css 的 HANAMIN 段 unicode-range 筛过（只收网站本来就会去取分片的字）。
输出（stdout，JSON 数组，与 jobs 一一对应）：
  [ { "out": "…", "range": "U+3484,U+3558-355A,…" | null } ]
  range 是子集里实际有字形的码位（分片里没有的字不收）；一个都没有时 range 为 null、不写文件。

产物可复现：同一组码位两次生成逐字节相同（不写当前时间戳），三处打包（data.yml 两个 job、deploy.yml）结果一致。
"""
import io
import json
import os
import re
import sys

from fontTools import subset
from fontTools.merge import Merger
from fontTools.ttLib import TTFont


def parse_unicode_range(text):
    out = []
    for part in text.split(','):
        part = part.strip().upper().replace('U+', '')
        if not part:
            continue
        if '-' in part:
            a, b = part.split('-', 1)
            out.append((int(a, 16), int(b, 16)))
        else:
            out.append((int(part, 16), int(part, 16)))
    return out


def load_slices(hanamin_dir):
    """HanaMin.css 里每条 @font-face：(分片文件名, [(起, 止), …])"""
    css = open(os.path.join(hanamin_dir, 'HanaMin.css'), encoding='utf-8').read()
    slices = []
    for m in re.finditer(r'@font-face\s*{([^}]*)}', css):
        body = m.group(1)
        src = re.search(r'url\(["\']?([^)"\']+\.woff2)', body)
        ur = re.search(r'unicode-range:\s*([^;}]+)', body)
        if src and ur:
            slices.append((os.path.basename(src.group(1)), parse_unicode_range(ur.group(1))))
    return slices


def compact_range(cps):
    parts = []
    i = 0
    while i < len(cps):
        j = i
        while j + 1 < len(cps) and cps[j + 1] == cps[j] + 1:
            j += 1
        parts.append('U+%X' % cps[i] if i == j else 'U+%X-%X' % (cps[i], cps[j]))
        i = j + 1
    return ','.join(parts)


class SliceCache:
    """分片解压一次（woff2 → sfnt 字节）、cmap 读一次，各章复用"""

    def __init__(self, hanamin_dir):
        self.dir = hanamin_dir
        self.raw = {}
        self.cmaps = {}

    def sfnt(self, name):
        if name not in self.raw:
            f = TTFont(os.path.join(self.dir, name), recalcTimestamp=False)
            f.flavor = None
            buf = io.BytesIO()
            f.save(buf)
            self.raw[name] = buf.getvalue()
            self.cmaps[name] = set(f.getBestCmap() or {})
        return self.raw[name]

    def cmap(self, name):
        self.sfnt(name)
        return self.cmaps[name]


def build(job, slices, cache):
    by_slice = {}
    for cp in sorted(set(job['cps'])):
        for name, ranges in slices:
            if any(a <= cp <= b for a, b in ranges):
                if cp in cache.cmap(name):
                    by_slice.setdefault(name, []).append(cp)
                break
    if not by_slice:
        return None
    parts = []
    for name in sorted(by_slice):
        f = TTFont(io.BytesIO(cache.sfnt(name)), recalcTimestamp=False)
        opts = subset.Options()
        opts.layout_features = []
        opts.hinting = False
        opts.notdef_outline = True
        opts.name_IDs = [0, 1, 2, 3, 4, 5, 6, 13, 14]  # 版权、字族名、许可（花园明朝 OFL／花園フォントライセンス：改版须保留版权与许可声明）
        opts.recalc_timestamp = False
        s = subset.Subsetter(opts)
        s.populate(unicodes=by_slice[name])
        s.subset(f)
        buf = io.BytesIO()
        f.save(buf)
        buf.seek(0)
        parts.append(buf)
    if len(parts) == 1:
        font = TTFont(parts[0], recalcTimestamp=False)
    else:
        head0 = TTFont(parts[0], recalcTimestamp=False)['head']
        stamp = (head0.created, head0.modified)
        for p in parts:
            p.seek(0)
        font = Merger().merge(parts)
        # Merger 把 head 的 created／modified 写成当前时间：改回源分片的，产物才可复现
        font['head'].created, font['head'].modified = stamp
        font.recalcTimestamp = False
    font.flavor = 'woff2'
    os.makedirs(os.path.dirname(job['out']) or '.', exist_ok=True)
    font.save(job['out'])
    cps = sorted(cp for v in by_slice.values() for cp in v)
    return compact_range(cps)


def main():
    req = json.load(sys.stdin)
    slices = load_slices(req['hanamin'])
    cache = SliceCache(req['hanamin'])
    out = []
    for job in req['jobs']:
        out.append({'out': job['out'], 'range': build(job, slices, cache)})
    json.dump(out, sys.stdout)


if __name__ == '__main__':
    main()
