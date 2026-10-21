#!/usr/bin/env python3
"""
zi-fonts.py — 扩展区生僻字的静态分片字体（GUJI-721 第 2 步，由 scripts/zi-fonts.mjs 调用，不单独跑）。

章的子集字体（chapter-fonts.py）只管构建时知道内容的章；搜索结果、元数据、专名页、输入框这些动态内容
构建时不知道会出什么字，靠这一层兜底：把 Jigmo 2025.9.12（CC0）非基本区的字按码位顺序每 PART_SIZE 个切一块，
每块一条带 unicode-range 的 @font-face（src/app/zi-fonts.css），页面出现哪块的字才下哪块。

输入（命令行）：zi-fonts.py <Jigmo 目录> <输出目录> <码位段 JSON，如 [[13312,19903],…]>
输出：每块写 <输出目录>/<首字码位，小写十六进制>.woff2；stdout 是 JSON 数组，按码位排：
  [ { "file": "3400.woff2", "range": "U+3400-34FF,…", "sha1": "…" } ]，range 是该块实际有字形的码位。
  文件名短（CSS 每页都下，内容哈希放进目录名、由 zi-fonts.mjs 按全部块的 sha1 算，CDN 照样可以永久缓存）。

字形裁法与章子集同一套（chapter-fonts.py 的 Jigmo 类、build_part），工具版本锁在 ops/setup-chapter-fonts.sh，
同样的输入两次生成逐字节相同。
"""
import hashlib
import importlib.util
import json
import os
import sys
from multiprocessing import Pool

sys.dont_write_bytecode = True  # 只是借用 chapter-fonts.py 的函数，不在 scripts/ 下留 __pycache__
_spec = importlib.util.spec_from_file_location('chapter_fonts', os.path.join(os.path.dirname(os.path.abspath(__file__)), 'chapter-fonts.py'))
cf = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(cf)

PART_SIZE = 256  # 与章子集切块一致：一块约 140KB（Jigmo 实测 0.5–97KB，共约 320 块、22MB）

_W = {}


def _init(jigmo_dir, out_dir):
    _W['jigmo'] = cf.Jigmo(jigmo_dir)
    _W['out'] = out_dir


def _build(cps):
    data, got = cf.build_part(_W['jigmo'], cps)
    name = '%x.woff2' % got[0]
    with open(os.path.join(_W['out'], name), 'wb') as f:
        f.write(data)
    return {'file': name, 'range': cf.compact_range(got), 'sha1': hashlib.sha1(data).hexdigest()}


def main():
    jigmo_dir, out_dir, ranges = sys.argv[1], sys.argv[2], json.loads(sys.argv[3])
    os.makedirs(out_dir, exist_ok=True)
    _init(jigmo_dir, out_dir)
    blocks = []
    for lo, hi in ranges:
        # 一块只从一档字体里取（同一码位段可能分在两档，如兼容补充），不必合并
        by_file = {}
        for cp in range(lo, hi + 1):
            k = _W['jigmo'].owner(cp)
            if k is not None:
                by_file.setdefault(k, []).append(cp)
        for k in sorted(by_file):
            cps = by_file[k]
            blocks += [cps[i:i + PART_SIZE] for i in range(0, len(cps), PART_SIZE)]
    blocks.sort(key=lambda b: b[0])
    # 一块约 0.35 秒（压 woff2 占大头），按 CPU 数并行
    with Pool(os.cpu_count() or 1, _init, (jigmo_dir, out_dir)) as pool:
        res = pool.map(_build, blocks, chunksize=4)
    json.dump(res, sys.stdout)


if __name__ == '__main__':
    main()
