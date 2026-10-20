# vol04 待审单（rev 004-r3）相似字：照网站判据数显示不出的字，再看换 Jigmo 2025／文津宋体后缺几个
# 用法：python vol04.py 004.pending.json
import sys, json
from collections import Counter
from blocks import block_of, can_show
ALT_SHOW, ALT_MAX = 10, 30   # nextjs/src/lib/proofing.ts
d = json.load(open(sys.argv[1], encoding="utf-8"))
cells = d["cells"]

def alt_of(cell):
    """照 proofing.ts parseExtras：只收单码点、去重留首个、截 ALT_MAX"""
    seen, out = set(), []
    for x in cell.get("alt") or []:
        c = x.get("c") if isinstance(x, dict) else None
        if not isinstance(c, str) or len(c) != 1 or c in seen: continue
        seen.add(c); out.append(c)
    return out[:ALT_MAX]

alts = [alt_of(c) for c in cells]
allz = set(z for a in alts for z in a)
topz = set(z for a in alts for z in a[:ALT_SHOW])
bad = {z for z in allz if not can_show(ord(z))}
badtop = bad & topz
cards = sum(1 for a in alts if a)
hit = sum(1 for a in alts if any(z in badtop for z in a[:ALT_SHOW]))
hit_all = sum(1 for a in alts if any(z in bad for z in a))
print(f"rev {d['rev']}  格 {len(cells)}  有相似字的卡 {cards}")
print(f"相似字去重 {len(allz)}  其中前 {ALT_SHOW} {len(topz)}")
print(f"显示不出 {len(bad)}  前 {ALT_SHOW} 里 {len(badtop)}  影响卡（前 {ALT_SHOW}）{hit}/{cards}  （展开全部）{hit_all}/{cards}")
print("分区（全部／前10）:")
ca, ct = Counter(block_of(ord(z)) for z in allz), Counter(block_of(ord(z)) for z in topz)
for k in ca: print(f"  {k}: {ca[k]}／{ct.get(k,0)}")
print("显示不出的分区:", dict(Counter(block_of(ord(z)) for z in bad)))
json.dump({"all": sorted(allz), "top": sorted(topz), "bad": sorted(bad), "badtop": sorted(badtop),
           "cards_bad": [[z for z in a if z in bad] for a in alts], "cards_badtop": [[z for z in a[:ALT_SHOW] if z in bad] for a in alts]}, open("vol04_zi.json", "w"), ensure_ascii=False)
