import pickle, json, os, glob
from collections import Counter, defaultdict
from blocks import *
S = pickle.load(open("scan.pkl","rb"))
cm = pickle.load(open("cmaps.pkl","rb"))
ROOT=os.environ.get("BOOK_TEXT", "../book-text")
# manifest: (id,key)->source, title
meta={}
for m in glob.glob(ROOT+"/Work/*/*/*/*/manifest.json")+glob.glob(ROOT+"/Book/*/*/*/*/manifest.json"):
    d=json.load(open(m)); wid=d["id"]
    for v in d["versions"]:
        meta[(wid,v["key"])]=v.get("source") or v.get("kind")
def title(kind,wid,key):
    g=glob.glob(f"{ROOT}/{kind}/*/*/*/{wid}/{key}/index.json")
    if not g: return ""
    d=json.load(open(g[0])); return d.get("version_label") or (d.get("source") or {}).get("page_title") or d.get("title","")
def report(sel, label):
    print(f"\n#### {label}")
    units=[k for k in S if sel(k)]
    basic=sum(S[k]["basic"] for k in units)
    rare=Counter()
    for k in units: rare.update(S[k]["rare"])
    print("units", len(units), "works", len({k[1] for k in units}), "files", sum(S[k]["files"] for k in units), "basic tokens", basic)
    rows=defaultdict(lambda:[0,0,0])
    for c,n in rare.items():
        b=block_of(ord(c)) or "其他"
        rows[b][0]+=1; rows[b][1]+=n
    # works containing each block
    for b in rows:
        rows[b][2]=sum(1 for k in units if any(block_of(ord(c))==b for c in S[k]["rare"]))
    for n,_,_ in ALL+[("其他",0,0)]:
        if n in rows: print(f"  {n}\t字种 {rows[n][0]}\t字次 {rows[n][1]}\t条目 {rows[n][2]}")
    han=[c for c in rare if inr(ord(c),HAN_OR_PUA)]
    bad=[c for c in han if not can_show(ord(c))]
    print("  现判据显示不出：字种", len(bad), "字次", sum(rare[c] for c in bad), "条目", sum(1 for k in units if any(not can_show(ord(c)) and inr(ord(c),HAN_OR_PUA) for c in S[k]["rare"])))
    bb=Counter()
    for c in bad: bb[block_of(ord(c))]+=rare[c]
    print("   by block (字次)", dict(bb))
    for f in ["花园明朝 0.0.5（网站现用）","Jigmo 2025.9.12（npm fontpkg-jigmo）","文津宋体 WenJin Mincho 2.012","Jigmo 20230816（cv 仓）","遍黑体 Plangothic","BabelStone Han 15.0.4","I.Ming 8.10"]:
        # 只看非 PUA 汉字；基本区按系统字体算有
        miss=[c for c in han if not inr(ord(c),[(0xe000,0xf8ff),(0xf0000,0x10ffff)]) and not (0x4e00<=ord(c)<=0x9fff) and ord(c) not in cm[f]]
        print(f"   缺字 {f}: 字种 {len(miss)} 字次 {sum(rare[c] for c in miss)}", (" 例 "+" ".join(f"U+{ord(c):X}" for c in miss[:6])) if miss else "")
    return units, rare
allu, allr = report(lambda k: True, "全仓（全部版本）")
du, dr = report(lambda k: k[2]=="default", "只算 default（阅读页主版本）")
pickle.dump(meta, open("meta.pkl","wb"))
# by source
print("\n#### 按来源（全部版本）")
src=defaultdict(list)
for k in S: src[meta.get((k[1],k[2]), "?")].append(k)
for s,us in sorted(src.items(), key=lambda x:-len(x[1])):
    r=Counter()
    for k in us: r.update(S[k]["rare"])
    def cnt(pred): 
        cs=[c for c in r if pred(ord(c))]; return f"{len(cs)}/{sum(r[c] for c in cs)}"
    pats=Counter()
    for k in us:
        for p,c in S[k]["pats"].items(): pats[p]+=sum(c.values())
    print(f"  {s}\t版本 {len(us)}\t基本区字次 {sum(S[k]['basic'] for k in us)}\t扩A {cnt(lambda o:0x3400<=o<=0x4dbf)}\t扩B–F {cnt(lambda o:0x20000<=o<=0x2ebef)}\t扩G–J,I {cnt(lambda o:0x2ebf0<=o<=0x2ee5f or 0x30000<=o<=0x3347f)}\t兼容 {cnt(lambda o:0xf900<=o<=0xfaff or 0x2f800<=o<=0x2fa1f)}\tPUA {cnt(lambda o:0xe000<=o<=0xf8ff or o>=0xf0000)}\t显示不出 {cnt(lambda o: inr(o,HAN_OR_PUA) and not can_show(o))}\t{dict(pats)}")
