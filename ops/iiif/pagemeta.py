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


def bim_page(entry, public_url, book_id, vol_dir, with_src_tier=False):
    """旁车一页 → canvas 的 `bim:page`。`with_src_tier`：源图档已上传时才写 `src.url`。"""
    H = [float(v) for r in entry['H'] for v in r]
    src = {'w': int(entry['src']['w']), 'h': int(entry['src']['h'])}
    if with_src_tier and not _identity(entry['H']):
        src = {'url': public_url(src_tier_key(book_id, vol_dir, src_slug(entry['src']['id']))), **src}
    return {'src': src, 'H': H, 'content': [int(v) for v in entry['content']]}


def canvas_extents(meta, wanted_seqs=None):
    """旁车 → {页表 seq: 该页记录}。"""
    if meta is None:
        return {}
    pages = meta['pages']
    return {s: e for s, e in pages.items() if wanted_seqs is None or s in wanted_seqs}
