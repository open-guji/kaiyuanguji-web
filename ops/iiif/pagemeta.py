"""页面范围旁车（cv `guji-pagemeta/1`）→ IIIF canvas 的 `bim:page`。

规范：ai-team `domain/网站与运维/规范/书影页面范围统一规范.md`；cv 侧落法：`domain/CV/图源迁移/页面范围pagemeta/落地说明.md`。

旁车在页表旁边：`pack/source/pages/<书id>/<册>/r<NNN>.page.v<K>.json`（只增不改，K 大的新），按页表各页 `seq:sha256` 的指纹认亲。
公开地址不能列目录，从 v1 往上探到 404 取最新版。canvas 里写：

    "bim:page": {"src": {"url"?: …, "w": …, "h": …}, "H": [9 个数，行优先，页图→源图], "content": [x, y, w, h]}

- `content`、`H`、`src.w/h` 原样来自旁车；字框坐标仍是页图像素，不动。
- `src.url`（源图档，阅读器「显示完整书页」开时显示的整幅图）只在源图档已上传时写；
  单页扫描（H 是单位阵、源图＝页图）不需要源图档，阅读器直接用页图。
"""
import hashlib
import json
import re
import urllib.error

SRC_TIER_W = 2400   # 源图档宽（合扫页的整幅图；一个半叶约占一半宽，1200 会太糊）


def table_sha(table):
    """与 cv `pagemeta.table_sha` 同：页的 `seq:sha256` 按页序拼起来取 sha256。"""
    h = hashlib.sha256()
    for p in table['pages']:
        h.update(f"{p['seq']}:{p['sha256']}\n".encode())
    return h.hexdigest()


def sidecar_url(pages_base, book_id, vol_dir, rev, v):
    return f'{pages_base}/pack/source/pages/{book_id}/{vol_dir}/r{rev:03d}.page.v{v}.json'


def load_pagemeta(table, pages_base, vol_dir, get):
    """这版页表的最新旁车；还没有旁车返回 None。旁车和页表对不上（指纹、书、册、rev）直接报错，不静默并。"""
    rev, latest, v = int(table['rev']), None, 1
    while True:
        try:
            body, _ = get(sidecar_url(pages_base, table['book_id'], vol_dir, rev, v), timeout=60, tries=3)
        except urllib.error.HTTPError as e:
            if e.code == 404:
                break
            raise
        latest = json.loads(body)
        v += 1
    if latest is None:
        return None
    if latest.get('schema') != 'guji-pagemeta/1' or latest.get('rev') != rev or latest.get('book_id') != table['book_id']:
        raise RuntimeError(f'{table["book_id"]}/{vol_dir} 旁车不是这版页表的（schema／书／rev 不符）')
    if latest.get('table_sha256') != table_sha(table):
        raise RuntimeError(f'{table["book_id"]}/{vol_dir} 旁车 v{latest.get("v")} 的 table_sha256 与页表 r{rev:03d} 对不上')
    return latest


def src_slug(src_id):
    """源图 id → 路径段：`WYG-SKQS-0001.djvu#235` → `WYG-SKQS-0001-235`；只留字母数字和连字符。"""
    stem, _, page = src_id.partition('#')
    stem = re.sub(r'\.djvu$', '', stem, flags=re.I)
    return re.sub(r'[^A-Za-z0-9]+', '-', stem + ('-' + page if page else '')).strip('-')


def src_tier_key(book_id, vol_dir, slug, width=SRC_TIER_W):
    return f'iiif/{book_id}/{vol_dir}/src/{slug}/full/{width},/0/default.webp'


def _identity(H):
    return all(abs(a - b) < 1e-9 for a, b in zip([v for r in H for v in r], [1, 0, 0, 0, 1, 0, 0, 0, 1]))


def _inv3(H):
    (a, b, c), (d, e, f), (g, h, i) = H
    det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g)
    if abs(det) < 1e-12:
        return None
    return [[(e * i - f * h) / det, (c * h - b * i) / det, (b * f - c * e) / det],
            [(f * g - d * i) / det, (a * i - c * g) / det, (c * d - a * f) / det],
            [(d * h - e * g) / det, (b * g - a * h) / det, (a * e - b * d) / det]]


def _apply(M, x, y):
    w = M[2][0] * x + M[2][1] * y + M[2][2] or 1.0
    return ((M[0][0] * x + M[0][1] * y + M[0][2]) / w, (M[1][0] * x + M[1][1] * y + M[1][2]) / w)


INNER_PAD = 8  # 版心边线（版框里靠版心的那条竖线）外多留的源图像素


def banxin_views(tpage, entry):
    """版心三档的另外两种取景（版心＝书口、鱼尾那一列，跨在左右两个半叶之间）。
    页表 `frame.pts`（源图 S 坐标）：t_R／b_R＝版框右外线、t_xr／b_xr＝版心右边线、t_xl／b_xl＝版心左边线、t_L／b_L＝版框左外线（上／下两端）。
    右半叶页图＝从版心中线到右外线，左半叶＝从左外线到版心中线，默认 `content`（中缝切开）每页带半条版心。
      · none：不显示版心——右半叶取 [版心右边线, 右外线]，左半叶取 [左外线, 版心左边线]，换到页图（P）坐标；
      · full：完整版心——右半叶取 [版心左边线, 右外线]，左半叶取 [左外线, 版心右边线]，留在源图（S）坐标。
    上下与外侧补白取页表 `frame.pad`。页表没有 frame／half，或点不全，返回 None（阅读器三档都按 content）。"""
    fr = (tpage or {}).get('frame') or {}
    pts, half = fr.get('pts'), (tpage or {}).get('half')
    need = ['t_R', 't_xr', 't_xl', 't_L', 'b_R', 'b_xr', 'b_xl', 'b_L']
    if half not in ('右', '左') or not isinstance(pts, dict) or any(k not in pts for k in need):
        return None
    pad = fr.get('pad') or {}
    pt, pb, po = float(pad.get('t', 36)), float(pad.get('b', 36)), float(pad.get('o', 36))
    X = lambda k: float(pts[k][0])  # noqa: E731
    Y = lambda k: float(pts[k][1])  # noqa: E731
    y0 = min(Y('t_R'), Y('t_xr'), Y('t_xl'), Y('t_L')) - pt
    y1 = max(Y('b_R'), Y('b_xr'), Y('b_xl'), Y('b_L')) + pb
    if half == '右':
        none_x0, none_x1 = min(X('t_xr'), X('b_xr')) - INNER_PAD, max(X('t_R'), X('b_R')) + po
        full_x0, full_x1 = min(X('t_xl'), X('b_xl')) - INNER_PAD, none_x1
    else:
        none_x0, none_x1 = min(X('t_L'), X('b_L')) - po, max(X('t_xl'), X('b_xl')) + INNER_PAD
        full_x0, full_x1 = none_x0, max(X('t_xr'), X('b_xr')) + INNER_PAD
    if not (none_x1 > none_x0 and full_x1 > full_x0 and y1 > y0):
        return None
    inv = _inv3(entry['H'])
    if inv is None:
        return None
    corners = [_apply(inv, x, y) for x in (none_x0, none_x1) for y in (y0, y1)]
    xs, ys = [c[0] for c in corners], [c[1] for c in corners]
    r = lambda v: int(round(v))  # noqa: E731
    nx0, ny0, nx1, ny1 = min(xs), min(ys), max(xs), max(ys)
    return {'none': [r(nx0), r(ny0), r(nx1 - nx0), r(ny1 - ny0)],
            'full': [r(full_x0), r(y0), r(full_x1 - full_x0), r(y1 - y0)]}


def bim_page(entry, public_url, book_id, vol_dir, with_src_tier=False, tpage=None):
    """旁车一页 → canvas 的 `bim:page`。`with_src_tier`：源图档已上传时才写 `src.url`。
    `tpage`：页表这一页（带 frame／half）时，再写 `views`（版心三档，见 banxin_views）；`full` 要源图档，没有 `src.url` 就不写。"""
    H = [float(v) for r in entry['H'] for v in r]
    src = {'w': int(entry['src']['w']), 'h': int(entry['src']['h'])}
    if with_src_tier and not _identity(entry['H']):
        src = {'url': public_url(src_tier_key(book_id, vol_dir, src_slug(entry['src']['id']))), **src}
    out = {'src': src, 'H': H, 'content': [int(v) for v in entry['content']]}
    v = banxin_views(tpage, entry) if tpage else None
    if v:
        out['views'] = {'none': v['none'], **({'full': v['full']} if 'url' in src else {})}
    return out


def canvas_extents(meta, wanted_seqs=None):
    """旁车 → {页表 seq: 该页记录}。"""
    if meta is None:
        return {}
    pages = meta['pages']
    return {s: e for s, e in pages.items() if wanted_seqs is None or s in wanted_seqs}
