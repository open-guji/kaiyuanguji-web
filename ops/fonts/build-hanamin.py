#!/usr/bin/env python3
"""
花园明朝（HanaMinA／HanaMinB）扩展区字兜底字体：从上游原始 ttf 切成 woff2 子集，并生成 @font-face CSS（overview#421）。

为什么要有：宋体系统字体不带扩展 A–F 的生僻字（如 𠮓＝爻、𫎇、㫖），读者机器上没有字体时显示成空白，
还会带坏同一段里后面的字（第 109 页「𠮓某卦自某卦而来」整串不可见）。

两层（CSS 里先声明的优先级低，后声明的高；同一个字取最后声明且 unicode-range 含它的那一个）：
  ① 全量分片（先声明）：HanaMinA 管扩展 A＋兼容表意文字，HanaMinB 管扩展 B–G 与兼容补充，
     按字体里实有的码位排序、在各负责区段内每 1024 个字一片（不跨区段），`unicode-range` 是片里码位的连续段。只有页面里出现了「系统字体里没有、
     且落在这片里」的字，浏览器才会下这一片。
  ② 实际用到的字（后声明）：只含 book-text 里真用到的字（hanamin-used-chars.txt，由 nextjs/scripts/collect-hanamin-chars.mjs 扫出，含繁简／异体转换后的字），
     几 KB；`unicode-range` 精确到这些字。常见情形（我们自己的书）只下这一个小文件。
  文件名由规则与输入决定（分片＝区段序号＋修订号，用到的字＝字表哈希），COS 上长缓存、immutable。

上游：https://glyphwiki.org/hanazono/hanazono-20170904.zip（sha256 锁死，下载后校验）；授权 Hanazono Font License／SIL OFL 1.1
双授权，随字体放 LICENSE.txt。字体里的版权、授权 name 记录保留（OFL 要求）。

用法（需要 fonttools、brotli：`pip install fonttools brotli`）：

    python3 build-hanamin.py [--out dist/hanamin] [--cache .cache] [--base https://data.kaiyuanguji.com/fonts/hanamin]

产出：<out>/*.woff2、hanamin.css（@font-face 全部）、manifest.json（文件名→大小、sha256）、LICENSE.txt、THANKS.txt。
再用 nextjs/scripts/sync-fonts-to-cos.mjs 传到 COS（先传、后部署 CSS，否则扩展区字照旧显示空白）。加 --write-globals 会把 hanamin.css
同步进 nextjs/src/app/globals.css 的「HANAMIN-BEGIN／END」之间。
"""
import argparse
import concurrent.futures as cf
import hashlib
import io
import json
import os
import re
import sys
import urllib.request
import zipfile

URL = 'https://glyphwiki.org/hanazono/hanazono-20170904.zip'
SHA256 = '571cd4a09ae7da0c642d640fc2442c050aa450ebb0587a95cdd097d41a9c9572'
HERE = os.path.dirname(os.path.abspath(__file__))
CHUNK = 1024
# 文件名里的修订号：分片规则（CHUNK、负责区段、子集选项）一变就加一，旧名字不会被覆盖——COS 上长缓存 immutable
REV = 'r2'

# 各字体负责的区段（只扩展区；常用字、基本区不在内，系统字体够用，网络字体不该下载）
FAMILIES = {
    'HanaMinA': ('HanaMinA.ttf', [(0x3400, 0x4DBF), (0xF900, 0xFAFF)]),
    'HanaMinB': ('HanaMinB.ttf', [(0x20000, 0x2FA1F), (0x30000, 0x3134F)]),
}
# 保留版权／授权等 name 记录
KEEP_NAMES = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 16, 17]


def fetch(cache: str) -> str:
    os.makedirs(cache, exist_ok=True)
    zpath = os.path.join(cache, 'hanazono-20170904.zip')
    if not os.path.exists(zpath):
        print('下载', URL, file=sys.stderr)
        req = urllib.request.Request(URL, headers={'User-Agent': 'Mozilla/5.0 (build-hanamin.py)'})
        with urllib.request.urlopen(req, timeout=300) as r, open(zpath, 'wb') as f:
            f.write(r.read())
    h = hashlib.sha256(open(zpath, 'rb').read()).hexdigest()
    if h != SHA256:
        raise SystemExit(f'上游压缩包 sha256 不对：{h}')
    out = os.path.join(cache, 'hanazono')
    if not os.path.exists(os.path.join(out, 'HanaMinB.ttf')):
        with zipfile.ZipFile(zpath) as z:
            z.extractall(out)
    return out


def ranges_of(cps):
    """码位列表 → 合并成连续区段"""
    out = []
    for cp in sorted(cps):
        if out and cp == out[-1][1] + 1:
            out[-1][1] = cp
        else:
            out.append([cp, cp])
    return out


def css_range(rs):
    return ', '.join(f'U+{a:X}' if a == b else f'U+{a:X}-{b:X}' for a, b in rs)


def subset_woff2(ttf: str, cps) -> bytes:
    from fontTools import subset
    from fontTools.ttLib import TTFont
    opts = subset.Options()
    opts.flavor = 'woff2'
    opts.layout_features = []
    opts.hinting = False
    opts.name_IDs = KEEP_NAMES
    opts.name_legacy = False
    opts.notdef_outline = True
    opts.glyph_names = False
    opts.drop_tables += ['DSIG', 'FFTM']
    font = TTFont(ttf)
    s = subset.Subsetter(opts)
    s.populate(unicodes=list(cps))
    s.subset(font)
    buf = io.BytesIO()
    font.flavor = 'woff2'
    font.save(buf)
    return buf.getvalue()


def job(args):
    ttf, cps, name = args
    return name, subset_woff2(ttf, cps)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', default=os.path.join(HERE, 'dist', 'hanamin'))
    ap.add_argument('--cache', default=os.path.join(HERE, '.cache'))
    ap.add_argument('--base', default='https://data.kaiyuanguji.com/fonts/hanamin')
    ap.add_argument('--used', default=os.path.join(HERE, 'hanamin-used-chars.txt'))
    ap.add_argument('--jobs', type=int, default=4)
    ap.add_argument('--write-globals', action='store_true', help='把 @font-face 块写进 nextjs/src/app/globals.css 的 HANAMIN-BEGIN／END 之间')
    args = ap.parse_args()

    from fontTools.ttLib import TTFont
    src = fetch(args.cache)
    os.makedirs(args.out, exist_ok=True)
    used = {ord(c) for c in open(args.used, encoding='utf-8').read() if not c.isspace()}

    plan = []  # (family, kind, name, ttf, cps)
    for fam, (fname, rs) in FAMILIES.items():
        ttf = os.path.join(src, fname)
        cmap = TTFont(ttf, lazy=True).getBestCmap()
        have = sorted(cp for cp in cmap if any(a <= cp <= b for a, b in rs))
        print(f'{fam}：负责区段里实有 {len(have)} 字', file=sys.stderr)
        # 分片不跨区段：扩展 A 与兼容表意文字之间隔着整个常用字区，跨过去的 unicode-range 会把常用字也圈进来
        n = 0
        for a, b in rs:
            seg = [cp for cp in have if a <= cp <= b]
            for i in range(0, len(seg), CHUNK):
                n += 1
                plan.append((fam, 'chunk', f'{fam}.{n:03d}.{REV}', ttf, seg[i:i + CHUNK]))
        mine = [cp for cp in sorted(used) if cp in set(have)]
        if mine:
            # 名字里带「用到的字」本身的哈希：字表变了名字就变，内容与名字一一对应，不依赖 fonttools 的压缩细节
            tag = hashlib.sha256(' '.join(map(str, mine)).encode()).hexdigest()[:8]
            plan.append((fam, 'used', f'{fam}.used.{tag}.{REV}', ttf, mine))
        missing = [chr(cp) for cp in sorted(used) if any(a <= cp <= b for a, b in rs) and cp not in set(have)]
        if missing:
            print(f'⚠ {fam} 里没有这些用到的字：{"".join(missing)}', file=sys.stderr)

    results = {}
    with cf.ProcessPoolExecutor(args.jobs) as ex:
        for (name, data), item in zip(ex.map(job, [(p[3], p[4], p[2]) for p in plan]), plan):
            fn = f'{name}.woff2'
            with open(os.path.join(args.out, fn), 'wb') as f:
                f.write(data)
            results[name] = (fn, len(data), hashlib.sha256(data).hexdigest())

    def face(fam, p):
        fn = results[p[2]][0]
        # 都取字体里实有码位的连续段（不用「首尾」一刀切，免得把没有这些字的中间区段圈进来）
        rs = ranges_of(p[4])
        return (f'@font-face {{ font-family: "{fam}"; font-style: normal; font-weight: 400; font-display: swap;\n'
                f'  src: url("{args.base}/{fn}") format("woff2");\n'
                f'  unicode-range: {css_range(rs)}; }}')

    css = ['/* 花园明朝扩展区字兜底（overview#421）。由 ops/fonts/build-hanamin.py 生成，不要手改。',
           '   先声明的优先级低：全量分片在前，「实际用到的字」小子集在后。 */']
    for kind in ('chunk', 'used'):
        for p in plan:
            if p[1] == kind:
                css.append(face(p[0], p))
    css_text = '\n'.join(css) + '\n'
    open(os.path.join(args.out, 'hanamin.css'), 'w', encoding='utf-8').write(css_text)
    if args.write_globals:
        gpath = os.path.join(HERE, '..', '..', 'nextjs', 'src', 'app', 'globals.css')
        g = open(gpath, encoding='utf-8').read()
        pat = re.compile(r'(/\* HANAMIN-BEGIN[^\n]*\*/\n).*?(/\* HANAMIN-END \*/)', re.S)
        if not pat.search(g):
            raise SystemExit('globals.css 里没有 HANAMIN-BEGIN／HANAMIN-END 标记')
        open(gpath, 'w', encoding='utf-8').write(pat.sub(lambda m: m.group(1) + css_text + m.group(2), g))
        print('已写入', os.path.normpath(gpath), file=sys.stderr)
    manifest = {
        'upstream': {'url': URL, 'sha256': SHA256, 'version': '2017-09-04'},
        'base': args.base,
        'files': {fn: {'bytes': n, 'sha256': h} for fn, n, h in results.values()},
    }
    json.dump(manifest, open(os.path.join(args.out, 'manifest.json'), 'w'), indent=1, ensure_ascii=False)
    for n in ('LICENSE.txt', 'THANKS.txt'):
        with open(os.path.join(src, n), 'rb') as r, open(os.path.join(args.out, n), 'wb') as w:
            w.write(r.read())
    total = sum(n for _, n, _ in results.values())
    used_total = sum(v[1] for k, v in results.items() if '.used.' in k)
    print(f'{len(results)} 个文件，共 {total / 1e6:.1f} MB（其中「用到的字」子集 {used_total / 1e3:.1f} KB）→ {args.out}', file=sys.stderr)
    return 0


if __name__ == '__main__':
    sys.exit(main())
