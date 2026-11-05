"""四庫總目（文淵閣本）海外书影：Commons DjVu 缩略图 → 本站页图的摆正矩阵。

页表（cv guji-pages/1，`encoding: wyg-frame-*`）每页有 `djvu_page`、`half`、`frame{pts,pad}`、`src`；
本站页图就是按这套版框从 600dpi DjVu 原图透视摆正裁出来的。海外读者改读 Commons 的 3840 宽缩略图时，
前端要把缩略图摆成同一张页图（逐字框、高亮都在页图坐标里）。这里算出「缩略图像素 → 页图像素」的 3×3 矩阵，写进 canvas，
前端只管套矩阵，不碰页表。算法按 A20 的参考实现（commons_warp.py::page_matrix，Commons 3840 摆正与本站图墨迹 IoU 0.91/0.94）。

Commons 缩略图只有 1920／3840 两档（2560 等非标准档报 400）；地址前端直接拼，不查 API（API 对我们限流 429）。
"""
import math
import re
import urllib.parse

THUMB_W = 3840
# DjVu 原图像素：冊 1–4 是 4296×6064，冊 5 是 4081×6048（A20 实测）
DJVU_SIZE = {1: (4296, 6064), 2: (4296, 6064), 3: (4296, 6064), 4: (4296, 6064), 5: (4081, 6048)}


def solve_homography(src, dst):
    """四点对应 → 3×3 单应矩阵（h33=1），纯 Python 高斯消元。"""
    a, b = [], []
    for (x, y), (u, v) in zip(src, dst):
        a.append([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.append(u)
        a.append([0, 0, 0, x, y, 1, -v * x, -v * y]); b.append(v)
    n = 8
    m = [row + [bb] for row, bb in zip(a, b)]
    for i in range(n):
        p = max(range(i, n), key=lambda r: abs(m[r][i]))
        if abs(m[p][i]) < 1e-12:
            raise ValueError('四点退化，解不出单应矩阵')
        m[i], m[p] = m[p], m[i]
        for r in range(n):
            if r != i:
                f = m[r][i] / m[i][i]
                m[r] = [x - f * y for x, y in zip(m[r], m[i])]
    h = [m[i][n] / m[i][i] for i in range(n)]
    return [[h[0], h[1], h[2]], [h[3], h[4], h[5]], [h[6], h[7], 1.0]]


def _matmul(a, b):
    return [[sum(a[i][k] * b[k][j] for k in range(3)) for j in range(3)] for i in range(3)]


def page_matrix(page, djvu_w, djvu_h):
    """页表一页 → 缩略图像素到页图像素的 3×3 矩阵（按 m[2][2] 归一）。

    四角：右半叶 [mt, t_R, b_R, mb]，左半叶 [t_L, mt, mb, b_L]（左上、右上、右下、左下），mt/mb 是版心两线中点。
    w0、h0 按原像素算；pts 按 k=缩略图宽/DjVu 原宽缩放后再求 Hm（→ 0..w0 × 0..h0）；
    T = 平移(l,t)·Hm，右半叶 l=0、r=o，左半叶 l=o、r=0；页图 W=w0+l+r、H=h0+t+b（应等于页表 w、h）。
    """
    fr = page['frame']
    p, pad = fr['pts'], fr['pad']
    mt = [(p['t_xl'][i] + p['t_xr'][i]) / 2 for i in (0, 1)]
    mb = [(p['b_xl'][i] + p['b_xr'][i]) / 2 for i in (0, 1)]
    if page['half'] == '右':
        quad, l, r = [mt, p['t_R'], p['b_R'], mb], 0, pad['o']
    elif page['half'] == '左':
        quad, l, r = [p['t_L'], mt, mb, p['b_L']], pad['o'], 0
    else:
        raise ValueError(f'half 只认 右／左：{page["half"]!r}')
    w0 = round(math.dist(quad[1], quad[0]))
    h0 = round(math.dist(quad[3], quad[0]))
    k = THUMB_W / djvu_w
    hm = solve_homography([[x * k, y * k] for x, y in quad], [(0, 0), (w0, 0), (w0, h0), (0, h0)])
    m = _matmul([[1, 0, l], [0, 1, pad['t']], [0, 0, 1]], hm)
    s = m[2][2]
    W, H = w0 + l + r, h0 + pad['t'] + pad['b']
    return [[v / s for v in row] for row in m], (W, H)


def djvu_volume(source):
    """Commons 来源项 → Commons 冊号（`…0005冊.djvu` → 5）；认不出返回 None。"""
    m = re.search(r'(\d{4})冊\.djvu', source.get('commons_title') or source.get('name') or '')
    return int(m.group(1)) if m else None


def thumb_url(source, djvu_page):
    """`…/commons/<a>/<ab>/<文件名>` → `…/commons/thumb/<a>/<ab>/<文件名>/page<N>-3840px-<文件名>.jpg`（md5 目录直接取原址）。"""
    url = source['commons_url']
    pre, _, rest = url.partition('/wikipedia/commons/')
    if not rest:
        raise ValueError(f'commons_url 不是 upload 原址：{url}')
    name = rest.rsplit('/', 1)[1]
    return f'{pre}/wikipedia/commons/thumb/{rest}/page{djvu_page}-{THUMB_W}px-{name}.jpg'


def canvas_commons(table, page):
    """页表一页 → canvas 的 `bim:commons` 字段；这页不带版框／来源不是 Commons 返回 None。"""
    if not page.get('frame') or not page.get('djvu_page'):
        return None
    src = next((s for s in table.get('sources', []) if s.get('key') == page.get('src')), None)
    if not src or src.get('kind') != 'commons' or not src.get('commons_url'):
        return None
    n = djvu_volume(src)
    if n not in DJVU_SIZE:
        return None
    dw, dh = DJVU_SIZE[n]
    m, (W, H) = page_matrix(page, dw, dh)
    if (W, H) != (page['w'], page['h']):
        # 页表宽高与摆正结果差 1px 以内是取整；差更多说明页表不是这套版框，不挂
        if abs(W - page['w']) > 1 or abs(H - page['h']) > 1:
            return None
    return {
        'url': thumb_url(src, page['djvu_page']),
        'width': THUMB_W, 'height': round(dh * THUMB_W / dw),
        'matrix': [round(v, 9) for row in m for v in row],
        'attribution': '景印文淵閣四庫全書，Wikimedia Commons',
    }
