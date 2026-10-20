# 把 Jigmo 2025 的扩A、扩B–J、兼容区按 256 码位切成 woff2，量每块大小
import sys, os, json
from multiprocessing import Pool
from fontTools import subset
from fontTools.ttLib import TTFont
F=os.environ.get("FONTS_DIR", "fonts") + "/fontpkg-jigmo/package/"
OUT=os.environ.get("CHUNK_DIR", "jigmo_chunks")
os.makedirs(OUT, exist_ok=True)
RANGES=[(0x3400,0x4DBF),(0xF900,0xFAFF),(0x20000,0x2A6DF),(0x2A700,0x2EE5F),(0x2F800,0x2FA1F),(0x30000,0x3347F)]
cmaps={f: set(TTFont(F+f, lazy=True).getBestCmap()) for f in ("Jigmo.ttf","Jigmo2.ttf","Jigmo3.ttf")}
jobs=[]
for a,b in RANGES:
    s=a - a%256
    while s<=b:
        cps=[o for o in range(max(s,a),min(s+255,b)+1)]
        for f,cm in cmaps.items():
            have=[o for o in cps if o in cm]
            if have: jobs.append((f,s,have))
        s+=256
def run(j):
    f,s,have=j
    out=f"{OUT}/{f[:-4]}-{s:05X}.woff2"
    if not os.path.exists(out):
        o=subset.Options(); o.flavor="woff2"; o.layout_features=[]; o.name_IDs=[]; o.notdef_outline=False; o.hinting=False
        font=TTFont(F+f); sb=subset.Subsetter(o); sb.populate(unicodes=have); sb.subset(font); font.save(out)
    return (f,s,len(have),os.path.getsize(out))
if __name__=="__main__":
    with Pool(4) as p: res=p.map(run, jobs, chunksize=4)
    json.dump(res, open("jigmo_chunks.json","w")); print(len(res), sum(r[3] for r in res))
