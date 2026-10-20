# book-index 元数据条目（网站元数据页／卡片）里的生僻字：整份 JSON 文本 + 题名（文件名）
import os, re, sys, pickle
from collections import Counter
from multiprocessing import Pool
from scan import RARE, BASIC
from scan2 import ZI, CBETA, BRACE, IDC
R=os.environ.get("BOOK_INDEX", "../book-index")
def scan(p):
    t=open(p,encoding='utf-8').read()
    name=os.path.basename(p)[:-5].split('-',1)[-1]
    return p.split('/')[len(R.split('/'))], Counter(RARE.findall(t)), Counter(RARE.findall(name)), len(BASIC.findall(t)), len(ZI.findall(t))+len(CBETA.findall(t))+len(BRACE.findall(t)), len(IDC.findall(t))
def files():
    for top in ("Work","Book","Collection","Entity"):
        for d,ds,fs in os.walk(os.path.join(R,top)):
            for f in fs:
                if f.endswith('.json'): yield os.path.join(d,f)
if __name__=='__main__':
    out=[]
    with Pool(4) as pool:
        for r in pool.imap_unordered(scan, files(), chunksize=500): out.append(r)
    pickle.dump(out, open("idx.pkl","wb")); print(len(out))
