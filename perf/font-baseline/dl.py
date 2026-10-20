# 每章阅读页要下载多少字体块（只算非基本区汉字；基本区靠系统字体）
import re, os, json, pickle, glob, statistics
from collections import Counter
F=os.environ.get("FONTS_DIR", "fonts")
def parse_ur(s):
    rs=[]
    for part in s.split(','):
        part=part.strip().replace('U+','')
        a,_,b=part.partition('-'); rs.append((int(a,16), int(b or a,16)))
    return rs
def css_chunks(css, root):
    out=[]
    for m in re.finditer(r'@font-face\s*\{(.*?)\}', open(css,encoding='utf-8').read(), re.S):
        body=m.group(1)
        url=re.search(r"url\([\"']?([^\"')]+)", body).group(1)
        ur=re.search(r'unicode-range:\s*([^;]+);', body)
        if not ur: continue
        fn=os.path.join(root, os.path.basename(url) if 'hanamin' in url else url)
        out.append((parse_ur(ur.group(1)), os.path.getsize(fn), os.path.basename(fn)))
    return out
HANA=css_chunks(os.path.join(os.path.dirname(__file__), "../../nextjs/src/app/globals.css"), F+"/hanamin/package")
WJ=[c for c in css_chunks(F+"/_free-fonts_wenjin-mincho/package/wenjin-mincho.css", F+"/_free-fonts_wenjin-mincho/package")
    if not all(0x4e00<=a and b<=0x9fff for a,b in c[0])]
JG=[([(s, s+255)], size, f"{f}-{s:05X}") for f,s,n,size in json.load(open("jigmo_chunks.json"))] if os.path.exists("jigmo_chunks.json") else []
def need(cps, chunks):
    hit=[c for c in chunks if any(a<=o<=b for o in cps for a,b in c[0])]
    return len(hit), sum(c[1] for c in hit)
chap=pickle.load(open("chap.pkl","rb"))
def pct(xs, p): xs=sorted(xs); return xs[min(len(xs)-1,int(len(xs)*p))]
res={}
for name, ch in (("花园明朝（现状）",HANA),("文津宋体 npm 256 块",WJ),("Jigmo 2025 自切 256 块",JG)):
    if not ch: continue
    n=[];b=[]
    for w,fn,L,cps in chap:
        if cps: k,s=need(cps,ch)
        else: k,s=0,0
        n.append(k); b.append(s)
    nz=[x for x in b if x]
    res[name]=dict(块数=len(ch), 总KB=round(sum(c[1] for c in ch)/1024), 中位块KB=round(statistics.median(c[1] for c in ch)/1024,1), 最大块KB=round(max(c[1] for c in ch)/1024), 章数=len(chap), 要下载的章=len(nz),
        块数_p50=pct(n,.5), 块数_p90=pct(n,.9), 块数_p99=pct(n,.99), 块数_max=max(n),
        KB_p50=round(pct(b,.5)/1024), KB_p90=round(pct(b,.9)/1024), KB_p99=round(pct(b,.99)/1024), KB_max=round(max(b)/1024),
        要下载的章KB中位=round(statistics.median(nz)/1024) if nz else 0)
    print(name, res[name], flush=True)
# 按章子集（GUJI-701 做法）估算：每字约 230 B + 约 2 KB 表头
nchars=[len(c[3]) for c in chap]
print("按章子集：每章非基本区字种 p50/p90/p99/max", pct(nchars,.5), pct(nchars,.9), pct(nchars,.99), max(nchars), "≈KB(p99)", round((pct(nchars,.99)*230+2048)/1024))
json.dump(res, open("dl.json","w"), ensure_ascii=False)
