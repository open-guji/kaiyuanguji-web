import os, re, sys, json, pickle
from collections import Counter, defaultdict
from multiprocessing import Pool
ROOT = os.environ.get("BOOK_TEXT", "../book-text")
# 关心的码位：扩A、兼容、PUA、IDC、平面2/3全部、平面15/16
RARE = re.compile('[㐀-䶿⿰-⿿㇯-豈-﫿\U00020000-\U0003ffff\U000f0000-\U0010ffff]')
BASIC = re.compile('[一-鿿]')
HAN = '㐀-䶿一-鿿豈-﫿\U00020000-\U0003ffff□⿰-⿿'
PATS = {
  # CBETA 组字式：方括号内有运算符 * / @ - + ( ) 且至少两个汉字
  "cbeta": re.compile(r'\[(?=[^\[\]\n]*[*/@+\-()])(?=(?:[^\[\]\n]*[' + HAN + r']){2})[^\[\]\n]{3,30}\]'),
  # 维基/自由式：花括号内 2–8 个汉字（含 □）
  "brace": re.compile(r'\{[' + HAN + r']{2,8}\}'),
  # guji-markdown 组字指令
  "zi": re.compile(r':zi\[[^\]\n]{1,40}\]'),
  # 方括号内 1 个大写字母 + 3 个十六进制（Big5/CNS 一类内码记法）
  "hexcode": re.compile(r'\[[A-F][0-9A-F]{3}\]'),
  # Kanripo 等的实体记法
  "entity": re.compile(r'&[A-Za-z]+[0-9A-Za-z]*;'),
  # IDS 串：IDC 起头，后接至少两个汉字/IDC
  "ids": re.compile('[⿰-⿿㇯][' + HAN + '⿰-⿿㇯' + ']{2,}'),
}
def unit(path):
    p = path[len(ROOT)+1:].split('/')
    # Work/c1/c2/c3/id/key/xxx.md
    return p[0], p[4], p[5]
def scan(path):
    try:
        t = open(path, encoding='utf-8').read()
    except Exception as e:
        return None
    kind, wid, key = unit(path)
    rare = Counter(RARE.findall(t))
    nb = len(BASIC.findall(t))
    pats = {k: Counter(r.findall(t)) for k, r in PATS.items()}
    pats = {k: v for k, v in pats.items() if v}
    return (kind, wid, key, os.path.basename(path), nb, rare, pats)
def files():
    for top in ("Work", "Book"):
        for d, ds, fs in os.walk(os.path.join(ROOT, top)):
            for f in fs:
                if f.endswith('.md') and f != 'CHANGES.md':
                    yield os.path.join(d, f)
if __name__ == '__main__':
    agg = defaultdict(lambda: {"files": 0, "basic": 0, "rare": Counter(), "pats": defaultdict(Counter), "chap_rare": Counter()})
    with Pool(4) as pool:
        for i, r in enumerate(pool.imap_unordered(scan, files(), chunksize=200)):
            if r is None: continue
            kind, wid, key, fn, nb, rare, pats = r
            a = agg[(kind, wid, key)]
            a["files"] += 1; a["basic"] += nb; a["rare"].update(rare)
            for k, v in pats.items(): a["pats"][k].update(v)
            # 每章生僻（扩 G 以后）字次，用来挑「一章最多」的样本
            gplus = sum(n for c, n in rare.items() if ord(c) >= 0x2EBF0 and ord(c) <= 0x3347F)
            if gplus: a["chap_rare"][fn] = gplus
            if i % 20000 == 0: print(i, file=sys.stderr, flush=True)
    out = {k: {"files": v["files"], "basic": v["basic"], "rare": dict(v["rare"]), "pats": {p: dict(c) for p, c in v["pats"].items()}, "chap_rare": dict(v["chap_rare"])} for k, v in agg.items()}
    pickle.dump(out, open("scan.pkl", "wb"))
    print("units", len(out))
