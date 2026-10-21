# 每章（default 版本）用到的非基本区汉字码位集合
import os
import pickle, re
from multiprocessing import Pool
from scan import files, unit
R=re.compile('[㐀-䶿豈-﫿\U00020000-\U0003ffff]')
def f(p):
    k,w,key=unit(p)
    if key!='default': return None
    t=open(p,encoding='utf-8').read()
    return (w, p.rsplit('/',1)[1], len(t), frozenset(ord(c) for c in R.findall(t)))
if __name__=='__main__':
    with Pool(2) as pool: out=[r for r in pool.imap_unordered(f, files(), chunksize=300) if r]
    pickle.dump(out, open('chap.pkl','wb')); print(len(out))
