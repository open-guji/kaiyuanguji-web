# vol04 相似字：各字体缺字、整单子集大小、按 256／128 码位块要拉多少（先跑 vol04.py 出 vol04_zi.json）
import os, re, io, json, glob
from multiprocessing import Pool
from fontTools import subset
from fontTools.ttLib import TTFont
from blocks import block_of
F = os.environ.get("FONTS_DIR", "fonts")
JG = F + "/fontpkg-jigmo/package/"
WJ = F + "/_free-fonts_wenjin-mincho/package/"
Z = json.load(open("vol04_zi.json", encoding="utf-8"))
SETS = {k: {ord(z) for z in v} for k, v in Z.items() if not k.startswith("cards")}
SETS["nonbasic"] = {o for o in SETS["all"] if block_of(o) != "基本区"}
SETS["nonbasic_top"] = {o for o in SETS["top"] if block_of(o) != "基本区"}

def woff2(path, cps):
    """同 jigmo_chunks.py 的裁法：woff2、去 layout／hinting／name"""
    o = subset.Options(); o.flavor = "woff2"; o.layout_features = []; o.name_IDs = []; o.notdef_outline = False; o.hinting = False
    f = TTFont(path); sb = subset.Subsetter(o); sb.populate(unicodes=cps); sb.subset(f)
    b = io.BytesIO(); f.save(b); return len(b.getvalue())

jg = {f: set(TTFont(JG + f, lazy=True).getBestCmap()) for f in ("Jigmo.ttf", "Jigmo2.ttf", "Jigmo3.ttf")}
jg_all = set().union(*jg.values())
wj_files = sorted(glob.glob(WJ + "fonts/*.woff2"))
wj = {p: set(TTFont(p, lazy=True).getBestCmap()) for p in wj_files}
wj_all = set().union(*wj.values())

def sub_jigmo(cps):
    return sum(woff2(JG + f, [o for o in cps if o in cm]) for f, cm in jg.items() if any(o in cm for o in cps))
def sub_wj(cps):
    return sum(woff2(p, [o for o in cps if o in cm]) for p, cm in wj.items() if any(o in cm for o in cps))

def chunk_job(j):
    f, s, n, have = j
    return (f, s, n, woff2(JG + f, have))

def jigmo_blocks(cps, n):
    """cps 落在哪些 n 码位块；块＝该字体在这 n 码位里的全部字（不只本单要的）"""
    jobs = []
    for f, cm in jg.items():
        for s in sorted({o - o % n for o in cps if o in cm}):
            jobs.append((f, s, n, [o for o in range(s, s + n) if o in cm]))
    return jobs

if __name__ == "__main__":
    out = {}
    for k in ("bad", "nonbasic", "all"):
        cps = SETS[k]
        out[k] = dict(字数=len(cps), Jigmo缺=len(cps - jg_all), 文津缺=len(cps - wj_all),
                      Jigmo缺字=[f"U+{o:X}" for o in sorted(cps - jg_all)], 文津缺字=[f"U+{o:X}" for o in sorted(cps - wj_all)])
        print(k, {a: b for a, b in out[k].items() if not isinstance(b, list) or b}, flush=True)
    for k in ("bad", "nonbasic", "all"):
        out[k]["Jigmo子集KB"] = round(sub_jigmo(SETS[k]) / 1024, 1)
        out[k]["文津子集KB"] = round(sub_wj(SETS[k]) / 1024, 1)
        print(k, "子集 Jigmo", out[k]["Jigmo子集KB"], "KB  文津", out[k]["文津子集KB"], "KB", flush=True)
    # 码位块：Jigmo 自切 256／128；文津 npm 现成块（按 css unicode-range）
    with Pool(4) as p:
        for n in (256, 128):
            for k in ("bad", "nonbasic"):
                res = p.map(chunk_job, jigmo_blocks(SETS[k], n), chunksize=2)
                out[k][f"Jigmo{n}块"] = len(res); out[k][f"Jigmo{n}KB"] = round(sum(r[3] for r in res) / 1024)
                out[k][f"Jigmo{n}最大块KB"] = round(max(r[3] for r in res) / 1024)
                print(k, n, len(res), "块", out[k][f"Jigmo{n}KB"], "KB 最大", out[k][f"Jigmo{n}最大块KB"], flush=True)
    for k in ("bad", "nonbasic"):
        hit = [p for p, cm in wj.items() if SETS[k] & cm]
        out[k]["文津npm块"] = len(hit); out[k]["文津npmKB"] = round(sum(os.path.getsize(p) for p in hit) / 1024)
        print(k, "文津 npm", len(hit), "块", out[k]["文津npmKB"], "KB", flush=True)
    # 缺省只展开前 10：前 10 里显示不出的整单子集；逐卡子集（一卡一个文件）
    out["badtop"] = dict(字数=len(SETS["badtop"]), Jigmo子集KB=round(sub_jigmo(SETS["badtop"]) / 1024, 1))
    for key in ("cards_bad", "cards_badtop"):
        sz = sorted(sub_jigmo({ord(z) for z in c}) for c in Z[key] if c)
        out[key] = dict(卡=len(sz), p50KB=round(sz[len(sz) // 2] / 1024, 1), p90KB=round(sz[int(len(sz) * .9)] / 1024, 1), maxKB=round(sz[-1] / 1024, 1))
    print({k: out[k] for k in ("badtop", "cards_bad", "cards_badtop")}, flush=True)
    json.dump(out, open("vol04_font.json", "w"), ensure_ascii=False, indent=1)
