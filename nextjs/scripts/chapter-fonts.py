#!/usr/bin/env python3
"""
chapter-fonts.py — 章的生僻字子集字体（GUJI-701 起；GUJI-721 字源换成 Jigmo，由 scripts/lib/chapter-fonts.mjs 调用，不单独跑）。

扩展区汉字的字源是 Jigmo 2025.9.12（字雲，CC0）三档 TTF：Jigmo（基本区、扩 A、兼容区）、Jigmo2（扩 B–F、扩 I、兼容补充）、
Jigmo3（扩 G、H、J）。一章用到的字从三档里各裁一份（hb-subset），合成一个 woff2，阅读页服务端渲染时追加 @font-face。
一章生僻字多（超过 PART_SIZE 个）就按调用方给的顺序（首次出现的先后）切成几块，每块一条 @font-face，读到才下。

输入（stdin，JSON）：
  { "jigmo": "<含 Jigmo.ttf、Jigmo2.ttf、Jigmo3.ttf 的目录>",
    "cache": "<可选：跨次缓存目录>", "prune": <可选：true＝本次没用到的缓存块删掉（只在全量打包时给）>,
    "jobs": [ { "out": "<第一块的输出路径，形如 …/001.font.woff2>", "cps": [码位, …] } ] }
  cps 由调用方筛过（只收要字体兜底的码位），按首次出现的先后排。
输出（stdout，JSON 数组，与 jobs 一一对应）：
  [ { "out": "…", "parts": [ { "file": "001.font.woff2", "range": "U+3484,U+3558-355A,…" }, { "file": "001.font-2.woff2", … } ] } ]
  range 是该块里实际有字形的码位；一个字形都没有时 parts 为空、不写文件。

产物可复现：hb-subset、fontTools、brotli 版本锁死（ops/setup-chapter-fonts.sh），合并时 head 的时间戳取源字体的，
同一组码位两次生成逐字节相同，三处打包（data.yml 两个 job、deploy.yml）结果一致。

全站约 12 万章，一章约 25 ms（裁三档、合并、压 woff2），所以按 CPU 数并行；给了 cache 目录就按「工具版本＋码位」
的哈希存取每一块，同一组码位下次直接拷（CI 用 actions/cache 跨次保留），只有新出现的码位组合才现裁。
"""
import hashlib
import io
import json
import os
import sys
from multiprocessing import Pool

import brotli
import fontTools
import uharfbuzz as hb
from fontTools.merge import Merger
from fontTools.ttLib import TTFont

FILES = ('Jigmo.ttf', 'Jigmo2.ttf', 'Jigmo3.ttf')
PART_SIZE = 256  # 每字约 0.55KB（woff2），一块约 140KB，合需求 §4.1-5「单块约 ≤150KB」
# 缓存键的前缀：字体、工具、本脚本的产物规则任一变了，旧缓存就不再命中
CACHE_TAG = 'jigmo-20250912|hb-%s|ft-%s|br-%s|v1' % (hb.__version__, fontTools.version, brotli.version)


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


def part_name(out, k):
    """第 1 块 001.font.woff2，第 2 块起 001.font-2.woff2"""
    base = os.path.basename(out)
    return base if k == 0 else base.replace('.font.woff2', '.font-%d.woff2' % (k + 1))


class Jigmo:
    """三档字体各载入一次（hb Face＋cmap），各章复用"""

    def __init__(self, d):
        self.faces = []
        self.cmaps = []
        self.stamps = []
        for name in FILES:
            path = os.path.join(d, name)
            self.faces.append(hb.Face(hb.Blob.from_file_path(path)))
            f = TTFont(path, lazy=True)
            self.cmaps.append(set(f.getBestCmap() or {}))
            self.stamps.append((f['head'].created, f['head'].modified))
            f.close()

    def owner(self, cp):
        for k, cm in enumerate(self.cmaps):
            if cp in cm:
                return k
        return None

    def subset(self, k, cps):
        inp = hb.SubsetInput()
        for cp in cps:
            inp.unicode_set.add(cp)
        inp.flags = hb.SubsetFlags.NO_HINTING
        return hb.subset(self.faces[k], inp).blob.data


def build_part(jigmo, cps):
    """一块：按档分组各裁一份，多档就合并；返回 (woff2 字节, 有字形的码位)"""
    by_file = {}
    for cp in cps:
        k = jigmo.owner(cp)
        if k is not None:
            by_file.setdefault(k, []).append(cp)
    if not by_file:
        return None, []
    ks = sorted(by_file)
    parts = [io.BytesIO(jigmo.subset(k, sorted(by_file[k]))) for k in ks]
    if len(parts) == 1:
        font = TTFont(parts[0], recalcTimestamp=False)
    else:
        font = Merger().merge(parts)
        font.recalcTimestamp = False
    # Merger 会把 head 的 created／modified 写成当前时间：一律改回源字体的，产物才可复现
    font['head'].created, font['head'].modified = jigmo.stamps[ks[0]]
    font.flavor = 'woff2'
    buf = io.BytesIO()
    font.save(buf)
    return buf.getvalue(), sorted(cp for k in ks for cp in by_file[k])


def cached_part(jigmo, cps, cache):
    """build_part 加缓存：键是工具版本＋该块码位（升序）的哈希，缓存里只存 woff2 字节（有字形的码位由 cmap 现算，不必存）"""
    if not cache:
        return build_part(jigmo, cps)
    got = sorted(cp for cp in cps if jigmo.owner(cp) is not None)
    if not got:
        return None, []
    key = hashlib.sha1(('%s|%s' % (CACHE_TAG, compact_range(got))).encode()).hexdigest()
    path = os.path.join(cache, key[:2], key + '.woff2')
    _W['used'].append(key)
    try:
        with open(path, 'rb') as f:
            return f.read(), got
    except OSError:
        pass
    data, got = build_part(jigmo, cps)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = '%s.%d.tmp' % (path, os.getpid())
    with open(tmp, 'wb') as f:
        f.write(data)
    os.replace(tmp, path)
    return data, got


def build(job, jigmo, cache=None):
    seen = set()
    order = [cp for cp in job['cps'] if not (cp in seen or seen.add(cp)) and jigmo.owner(cp) is not None]
    out = []
    d = os.path.dirname(job['out']) or '.'
    for k in range(0, len(order), PART_SIZE):
        data, cps = cached_part(jigmo, order[k:k + PART_SIZE], cache)
        if not data:
            continue
        name = part_name(job['out'], len(out))
        os.makedirs(d, exist_ok=True)
        with open(os.path.join(d, name), 'wb') as f:
            f.write(data)
        out.append({'file': name, 'range': compact_range(cps)})
    return out


_W = {}


def _init(jigmo_dir, cache):
    _W['jigmo'] = Jigmo(jigmo_dir)
    _W['cache'] = cache
    _W['used'] = []


def _run(job):
    _W['used'] = []
    parts = build(job, _W['jigmo'], _W['cache'])
    return {'out': job['out'], 'parts': parts}, _W['used']


def prune(cache, used):
    """删掉本次没用到的缓存块：缓存只留当前全站用得到的，不随时间越积越大"""
    removed = 0
    for sub in os.listdir(cache):
        d = os.path.join(cache, sub)
        if not os.path.isdir(d):
            continue
        for name in os.listdir(d):
            if name.endswith('.woff2') and name[:-6] not in used:
                os.unlink(os.path.join(d, name))
                removed += 1
    return removed


def main():
    req = json.load(sys.stdin)
    jobs = req['jobs']
    cache = req.get('cache') or None
    n = min(os.cpu_count() or 1, max(1, len(jobs) // 200))
    if n <= 1:
        _init(req['jigmo'], cache)
        res = [_run(j) for j in jobs]
    else:
        with Pool(n, _init, (req['jigmo'], cache)) as pool:
            res = pool.map(_run, jobs, chunksize=64)
    if cache and req.get('prune'):
        used = {k for _, keys in res for k in keys}
        print('chapter-fonts: 缓存删掉 %d 个本次没用到的块，留 %d 个' % (prune(cache, used), len(used)), file=sys.stderr)
    json.dump([r for r, _ in res], sys.stdout)


if __name__ == '__main__':
    main()
