"""生成 contract/smoke_queries.json：5 条固定查询（限定书），金标＝对原文暴力扫描的段数。
用法: make_smoke.py --text-root DIR [--out contract/smoke_queries.json]
book-text 内容变化后需重跑并人工复核（verify_pack 要求命中数与金标逐条相等）。"""
import argparse,glob,json,os,sys
HERE=os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0,os.path.dirname(HERE))
from common import passages,stream,query_stream
# (id, entry, field, query, 说明)
QUERIES=[
 ('bigram','d59f2hq1e9ky','norm','太極','两字，繁体查询经归一'),
 ('variant','d59f2hq1e9ky','norm','天地万物之理','简体查询命中繁体原文（norm 层）'),
 ('single','d59f2hq1e9ky','norm','理','单字，走 norm1'),
 ('orig_exact','d59f2hq1e9ky','orig','天地萬物之理','原字层精确匹配'),
 ('zero','d59f2hq1e9ky','norm','龘龘龘','无命中'),
]
def brute(text_root,entry,field,q):
    d=[p for top in('Work','Book') for p in glob.glob(f'{text_root}/{top}/*/*/*/{entry}')][0]
    qo,qn=query_stream(q); qs=qn if field=='norm' else qo
    n=0
    for f in sorted(glob.glob(d+'/default/*.md')):
        md=open(f,encoding='utf-8').read()
        for s,e,_ in passages(md):
            o,nn,_=stream(md[s:e])
            if qs in ''.join(nn if field=='norm' else o): n+=1
    return n
def main():
    ap=argparse.ArgumentParser(); ap.add_argument('--text-root',required=True)
    ap.add_argument('--out',default=os.path.join(HERE,'..','contract','smoke_queries.json'))
    a=ap.parse_args()
    out=[dict(id=i,entry=e,field=f,q=q,note=n,expect=brute(a.text_root,e,f,q)) for i,e,f,q,n in QUERIES]
    os.makedirs(os.path.dirname(os.path.abspath(a.out)),exist_ok=True)
    json.dump(out,open(a.out,'w',encoding='utf-8'),ensure_ascii=False,indent=1)
    for o in out: print(o['id'],o['q'],o['expect'])
if __name__=='__main__': main()
