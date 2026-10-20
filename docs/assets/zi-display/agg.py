import sys, json, collections, os, statistics
sys.path.insert(0, sys.argv[1]); S=sys.argv[2]; BT='/home/claude/book-text'
from blocks import BLOCKS, block_of
hana=set(json.load(open(S+'/m/cmap_HanaMin.json'))); jig=set(json.load(open(S+'/m/cmap_Jigmo.json')))
jig_old=set(json.load(open(S+'/m/cmap_Jigmo_old.json')))
tok=collections.Counter(); typ=collections.defaultdict(set); chap_with=collections.Counter()
ent_rare=collections.defaultdict(set); comp=collections.Counter(); comp_ent=collections.defaultdict(set)
pua_ent=collections.defaultdict(collections.Counter)
chap_sizes=[]; nfiles=0; nbasic=0; chap_beyond_hana=0; ent_beyond_hana=set(); ent_all=set()
beyond_hana=collections.Counter(); beyond_jig=collections.Counter(); beyond_jig_old=collections.Counter()
per_chap=[]
for line in open(S+'/m/scan.jsonl'):
    r=json.loads(line); p=r[0]; nfiles+=1; nbasic+=r[1]
    parts=p.split('/'); i=parts.index('Work') if 'Work' in parts else parts.index('Book')
    eid=parts[i]+'/'+parts[i+4]; ver=parts[i+5]; ent_all.add(eid)
    if len(r)<3: continue
    rare,cmp=r[2],r[3]
    hans=[]; bh=False
    for ch,n in rare.items():
        cp=ord(ch); b=block_of(cp); tok[b]+=n; typ[b].add(cp)
        if b in ('pua','spua'): pua_ent[eid][cp]+=n
        if b=='ids': continue
        hans.append(cp)
        if cp not in hana: beyond_hana[cp]+=n; bh=True
        if cp not in jig: beyond_jig[cp]+=n
        if cp not in jig_old: beyond_jig_old[cp]+=n
    for b in {block_of(ord(c)) for c in rare}: chap_with[b]+=1
    if bh: chap_beyond_hana+=1; ent_beyond_hana.add(eid)
    ent_rare[eid] |= set(hans)
    per_chap.append((len(hans), p))
    for k,n in cmp.items():
        kind=k.split('\t')[0]; comp[kind]+=n; comp_ent[kind].add(eid); comp['T\t'+k]+=n
out={'files':nfiles,'entries':len(ent_all),'basic_tokens':nbasic}
out['blocks']={b:{'types':len(typ[b]),'tokens':tok[b],'chapters':chap_with[b]} for b,*_ in BLOCKS}
out['beyond_hana']={'types':len(beyond_hana),'tokens':sum(beyond_hana.values()),'chapters':chap_beyond_hana,'entries':len(ent_beyond_hana),
  'by_block':collections.Counter(block_of(c) for c in beyond_hana)}
out['beyond_jigmo2025']={'types':len(beyond_jig),'tokens':sum(beyond_jig.values()),'by_block':collections.Counter(block_of(c) for c in beyond_jig)}
out['beyond_jigmo2023']={'types':len(beyond_jig_old),'tokens':sum(beyond_jig_old.values()),'by_block':collections.Counter(block_of(c) for c in beyond_jig_old)}
ns=sorted(n for n,_ in per_chap)
def q(x): return ns[min(len(ns)-1,int(len(ns)*x))]
out['chap_rare_types']={'n_chapters_with_rare':len(ns),'p50':q(.5),'p90':q(.9),'p99':q(.99),'p999':q(.999),'max':ns[-1],
  'over_600':sum(1 for n in ns if n>600),'over_300':sum(1 for n in ns if n>300),'top':sorted(per_chap,reverse=True)[:8]}
out['comp']={k:v for k,v in comp.items() if not k.startswith('T\t')}
out['comp_entries']={k:len(v) for k,v in comp_ent.items()}
out['comp_top']={kind:[(k.split('\t',2)[2],v) for k,v in comp.most_common() if k.startswith('T\t'+kind+'\t')][:15] for kind in ('cb','hex','br','ids')}
out['comp_types']={kind:sum(1 for k in comp if k.startswith('T\t'+kind+'\t')) for kind in ('cb','hex','br','ids')}
# PUA by entry with source
def src(eid):
    try:
        m=json.load(open(BT+'/'+eid.split('/')[0]+'/'+'/'.join(eid.split('/')[1][:0] or [])))
    except Exception: return None
pe=sorted(pua_ent.items(), key=lambda kv:-sum(kv[1].values()))
out['pua_entries']=len(pe)
out['pua_top']=[(e,sum(c.values()),len(c)) for e,c in pe[:15]]
ent_sizes=sorted(len(v) for v in ent_rare.values())
out['entry_rare_types']={'p50':ent_sizes[len(ent_sizes)//2],'p90':ent_sizes[int(len(ent_sizes)*.9)],'max':ent_sizes[-1]}
json.dump(out, open(S+'/m/agg.json','w'), ensure_ascii=False, indent=1, default=list)
json.dump({p:n for n,p in per_chap}, open(S+'/m/perchap_n.json','w'))
print(json.dumps(out, ensure_ascii=False, indent=1, default=list)[:9000])
