import os, re, sys, json, collections
from multiprocessing import Pool
ROOT = sys.argv[1]; OUT = sys.argv[2]
RARE = re.compile('[⿰-⿿㇯㐀-䶿-豈-﫿\U00020000-\U0003FFFF\U000F0000-\U0010FFFF]')
HAN = re.compile('[一-鿿]')
CJK = '㐀-鿿豈-﫿\U00020000-\U0003FFFF⿰-⿿□'
R_CB = re.compile(r'\[([%s][^\[\]\n]{0,20}?[*/@+\-－][^\[\]\n]{0,20})\](?!\()' % CJK)
R_HEX = re.compile(r'\[([0-9A-F]{4,5})\]')
R_BR = re.compile(r'\{([%s][%s ]{1,9})\}' % (CJK, CJK))
R_IDS = re.compile('[⿰-⿿㇯][^\\s，。、；：「」『』（）]{2,12}')
def work(path):
    try: t = open(path, encoding='utf-8').read()
    except Exception: return None
    rare = collections.Counter(RARE.findall(t))
    nb = len(HAN.findall(t))
    comp = collections.Counter()
    for r, k in ((R_CB,'cb'),(R_HEX,'hex'),(R_BR,'br')):
        for m in r.findall(t): comp[k+'\t'+m] += 1
    for m in R_IDS.findall(t): comp['ids\t'+m] += 1
    return path, nb, dict(rare), dict(comp)
def files():
    for top in ('Work','Book'):
        for dp, dn, fn in os.walk(os.path.join(ROOT, top)):
            for f in fn:
                if re.fullmatch(r'\d{3,4}\.md', f): yield os.path.join(dp, f)
if __name__ == '__main__':
    with Pool(4) as p, open(OUT, 'w') as o:
        for r in p.imap_unordered(work, files(), chunksize=64):
            if r and (r[2] or r[3]): o.write(json.dumps(r, ensure_ascii=False)+'\n')
            elif r: o.write(json.dumps([r[0], r[1]], ensure_ascii=False)+'\n')
