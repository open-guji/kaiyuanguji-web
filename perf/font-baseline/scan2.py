# 第二遍：组字式按互斥次序分类（:zi 指令 → CBETA 组字式 → 花括号 → 裸 IDS 串 → 内码 → KR 实体），IDS 按语法解析
import os, re, sys, pickle
from collections import Counter, defaultdict
from multiprocessing import Pool
from scan import files, unit, HAN
ARITY = {**{c: 2 for c in '⿰⿱⿴⿵⿶⿷⿸⿹⿺⿻⿼⿽㇯'}, '⿲': 3, '⿳': 3, '⿾': 1, '⿿': 1}
HANC = re.compile('[' + HAN + '？〇]')
def parse_ids(t, i):
    """从 t[i] 起解析一个 IDS，返回结束位置；不成立返回 -1"""
    if i >= len(t): return -1
    c = t[i]
    if c in ARITY:
        j = i + 1
        for _ in range(ARITY[c]):
            j = parse_ids(t, j)
            if j < 0: return -1
        return j
    return i + 1 if HANC.match(c) and c not in ARITY else -1
ZI = re.compile(r':zi\[[^\]\n]{1,60}\]')
CBETA = re.compile(r'\[(?=[^\[\]\n]*[*/@+\-()])(?=(?:[^\[\]\n]*[' + HAN + r']){2})[^\[\]\n]{3,40}\]')
BRACE = re.compile(r'\{[' + HAN + r']{2,8}\}')
HEX = re.compile(r'\[[A-F][0-9A-F]{3}\]')
KR = re.compile(r'&KR\d+;')
IDC = re.compile('[⿰-⿿㇯]')
def scan(path):
    t = open(path, encoding='utf-8').read()
    kind, wid, key = unit(path)
    out = defaultdict(Counter)
    def take(rx, name, s):
        def rep(m):
            out[name][m.group(0)] += 1
            return '\0' * len(m.group(0))
        return rx.sub(rep, s)
    for rx, name in ((ZI, 'zi'), (CBETA, 'cbeta'), (BRACE, 'brace'), (HEX, 'hexcode'), (KR, 'kr')):
        t = take(rx, name, t)
    i = 0
    for m in IDC.finditer(t):
        if m.start() < i: continue
        j = parse_ids(t, m.start())
        if j > 0:
            out['ids'][t[m.start():j]] += 1; i = j
        else:
            out['idc_stray'][t[m.start():m.start()+6]] += 1
    return kind, wid, key, {k: dict(v) for k, v in out.items()}
if __name__ == '__main__':
    agg = defaultdict(lambda: defaultdict(Counter))
    with Pool(4) as pool:
        for kind, wid, key, pats in pool.imap_unordered(scan, files(), chunksize=200):
            for k, v in pats.items(): agg[(kind, wid, key)][k].update(v)
    pickle.dump({k: {p: dict(c) for p, c in v.items()} for k, v in agg.items()}, open("pats.pkl", "wb"))
    tot = defaultdict(Counter)
    for v in agg.values():
        for p, c in v.items(): tot[p].update(c)
    for p, c in tot.items(): print(p, '种', len(c), '次', sum(c.values()), '条目', sum(1 for v in agg.values() if p in v), c.most_common(6))
