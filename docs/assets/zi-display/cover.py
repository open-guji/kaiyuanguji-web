import sys, glob, json, collections
sys.path.insert(0, sys.argv[1])
from blocks import BLOCKS, block_of
from fontTools.ttLib import TTFont
S=sys.argv[2]; CV='/home/claude/open-guji-cv/fonts'
groups = {
 'HanaMin 0.0.5(网站现用)': glob.glob(S+'/fonts/hanamin-0.0.5/package/HanaMin[AB].*.woff2'),
 'I.Ming 8.10': [CV+'/iming/I.Ming-8.10.ttf'],
 'Jigmo 20230816(cv仓)': glob.glob(CV+'/jigmo/Jigmo*.ttf'),
 'Jigmo 2025.9.12': glob.glob(S+'/fonts/fontpkg-jigmo-*/package/Jigmo*.ttf'),
 'BabelStone Han': glob.glob(S+'/fonts/fontpkg-babel-stone-han-*/package/*.ttf'),
 'Plangothic 遍黑体': glob.glob(S+'/fonts/free-fonts-plangothic-*/package/fonts/*.woff2'),
 '思源宋体 SC 2.003': glob.glob(S+'/fonts/fontpkg-source-han-serif-sc-*/package/*Regular.otf'),
 '全字库正宋体': glob.glob(S+'/fonts/fontpkg-tw-sung-*/package/*.ttf'),
 'Unifont 15.0.01': glob.glob(S+'/fonts/fontpkg-unifont-*/package/*.ttf'),
}
res = {}
for g, fs in groups.items():
    cps=set(); meta=set()
    for f in fs:
        t=TTFont(f, lazy=True, fontNumber=0)
        cps |= set(t.getBestCmap() or {})
        n=t['name']
        meta.add((str(n.getDebugName(4)), str(n.getDebugName(5)), (str(n.getDebugName(13)) or '')[:60]))
    c=collections.Counter(block_of(x) for x in cps)
    res[g]={'n_files':len(fs),'blocks':{k:c.get(k,0) for k,*_ in BLOCKS},'meta':sorted(meta)[:3]}
    json.dump(sorted(cps), open(S+'/m/cmap_'+g.split()[0]+('_old' if '2023' in g else '')+'.json','w'))
    print(g, len(fs), res[g]['blocks'], sorted(meta)[:2], flush=True)
json.dump(res, open(S+'/m/cover.json','w'), ensure_ascii=False, indent=1)
