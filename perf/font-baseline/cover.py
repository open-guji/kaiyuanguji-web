import sys, glob, os, json, pickle
from fontTools.ttLib import TTFont, TTCollection
from blocks import *
F=os.environ.get("FONTS_DIR", "fonts")
CV=os.environ.get("CV_FONTS", "../open-guji-cv/fonts")
FONTS = {
 "花园明朝 0.0.5（网站现用）": (F+"/hanamin/package", "HanaMin*.woff2"),
 "Jigmo 20230816（cv 仓）": (CV+"/jigmo", "*.ttf"),
 "Jigmo 2025.9.12（npm fontpkg-jigmo）": (F+"/fontpkg-jigmo/package", "*.ttf"),
 "I.Ming 8.10": (CV+"/iming", "*.ttf"),
 "源樣明體 GenYoMin2": (CV+"/genmin", "GenYoMin2TC-R.otf"),
 "文津宋体 WenJin Mincho 2.012": (F+"/_free-fonts_wenjin-mincho/package/fonts", "*.woff2"),
 "遍黑体 Plangothic": (F+"/_free-fonts_plangothic/package/fonts", "*.woff2"),
 "BabelStone Han 15.0.4": (F+"/_fontpkg_babel-stone-han/package", "*.ttf"),
 "思源宋体 SC 2.003": (F+"/_fontpkg_source-han-serif-sc/package", "SourceHanSerifSC-Regular.otf"),
 "Noto Serif SC（fontsource 5.3.1）": (F+"/_fontsource_noto-serif-sc/package/files", "noto-serif-sc-*-400-normal.woff2"),
 "全字库正宋体 TW-Sung": (F+"/_fontpkg_tw-sung/package", "*.ttf"),
}
cmaps = {}
for name,(d,pat) in FONTS.items():
    cps=set(); files=sorted(glob.glob(os.path.join(d,pat)))
    for fp in files:
        f = TTFont(fp, lazy=True, fontNumber=0)
        cm = f.getBestCmap() or {}
        cps.update(cm.keys())
    cmaps[name]=cps
    row=[name, len(files)]+[len([c for c in cps if a<=c<=b]) for _,a,b in BLOCKS]+[len([c for c in cps if a<=c<=b]) for n,a,b in OTHER[:5]]
    print("\t".join(map(str,row)), flush=True)
pickle.dump(cmaps, open("cmaps.pkl","wb"))
