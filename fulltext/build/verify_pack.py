"""F2 步 3：索引包校验。
用法: verify_pack.py <fulltext-*.tar.gz> [--text-root DIR] [--smoke contract/smoke_queries.json] [--sample 20]
检查：①manifest 每个文件 sha256＋字节数；②打开索引跑 smoke 查询，命中段数＝金标；
③抽 N 段（固定种子），按 start/end 回 default/*.md 原文，经 stream() 取 orig 前缀做 orig 短语查询，须能命中该段；
④（给了 --text-root）样本书每章 len(orig)==len(norm) 且 norm[i]==charmap(orig[i])，并输出 char.json 与 stream() 差异数（备查）。
②③④中缺 --text-root 的项会跳过并明说。退出码：0 通过；2 参数错；4 校验失败。"""
import argparse,glob,hashlib,json,os,random,sys,tarfile,tempfile,zlib
HERE=os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0,os.path.dirname(HERE))
import tantivy
from common import CMAP,stream,query_stream
FAILS=[]
def fail(msg): FAILS.append(msg); print('FAIL',msg)
def sha256_file(p):
    h=hashlib.sha256()
    with open(p,'rb') as f:
        for b in iter(lambda:f.read(1<<20),b''): h.update(b)
    return h.hexdigest()
def toks(s): return ' '.join(s[i:i+2] for i in range(len(s)-1))
def phrase(field,qs):
    """与 server.build_query 同口径：单字走 field1，其余双字短语。"""
    if len(qs)==1: return f'{field}1:{qs}',field+'1'
    t=toks(qs); return (f'{field}:"{t}"' if len(qs)>2 else f'{field}:{t}'),field
def book_dir(root,eid):
    c=[p for top in('Work','Book') for p in glob.glob(f'{root}/{top}/*/*/*/{eid}')]
    return c[0] if c else None
def check_files(root,m):
    for rel,info in m['files'].items():
        p=os.path.join(root,rel)
        if not os.path.isfile(p): fail(f'缺文件 {rel}'); continue
        if os.path.getsize(p)!=info['bytes']: fail(f'字节数不符 {rel}')
        elif sha256_file(p)!=info['sha256']: fail(f'sha256 不符 {rel}')
    print(f"files: {len(m['files'])} 个已核")
def open_index(root):
    return tantivy.Index.open(os.path.join(root,'index'))
def count(ix,entry,field,qs):
    q,df=phrase(field,qs)
    query=tantivy.Query.boolean_query([(tantivy.Occur.Must,ix.parse_query(q,[df])),
                                       (tantivy.Occur.Must,ix.parse_query(f'entry:{entry}',['entry']))])
    return ix.searcher().search(query,1,count=True).count
def check_smoke(ix,m,path):
    qs=json.load(open(path,encoding='utf-8')); ran=0
    for s in qs:
        if s['entry'] not in m['perBook']: print(f"smoke {s['id']}: 书 {s['entry']} 不在包内，跳过"); continue
        _,qn=query_stream(s['q']); qq=qn if s['field']=='norm' else query_stream(s['q'])[0]
        got=count(ix,s['entry'],s['field'],qq); ran+=1
        (print if got==s['expect'] else fail)(f"smoke {s['id']} {s['q']}: 得 {got} 金标 {s['expect']}")
    if ran==0: fail('smoke 一条都没跑（包内无金标涉及的书）')
def check_sample(ix,m,root,n):
    docs=ix.searcher(); rng=random.Random(20261012)
    books=sorted(m['perBook']); picked=[]
    for _ in range(n*5):
        if len(picked)>=n: break
        e=rng.choice(books)
        r=docs.search(ix.parse_query(f'entry:{e}',['entry']),200)
        if not r.hits: continue
        d=docs.doc(rng.choice(r.hits)[1])
        picked.append((e,d['chapter'][0],d['start'][0],d['end'][0]))
    ok=0
    for e,ch,s,en in picked:
        d=book_dir(root,e); p=f'{d}/default/{ch}.md' if d else None
        if not p or not os.path.exists(p): fail(f'抽样回原文：{e}/{ch} 找不到'); continue
        md=open(p,encoding='utf-8').read(); o,_,_=stream(md[s:en])
        if not o: fail(f'抽样 {e}/{ch}[{s}:{en}] 回原文后字流为空'); continue
        pre=''.join(o[:8])
        if len(pre)<2: ok+=1; continue
        q,df=phrase('orig',pre)
        query=tantivy.Query.boolean_query([(tantivy.Occur.Must,ix.parse_query(q,[df])),(tantivy.Occur.Must,ix.parse_query(f'entry:{e}',['entry']))])
        hits=docs.search(query,2000).hits
        if any(docs.doc(h[1])['chapter'][0]==ch and docs.doc(h[1])['start'][0]==s for h in hits): ok+=1
        else: fail(f'抽样 {e}/{ch}[{s}:{en}] orig 前缀「{pre}」未命中该段')
    print(f'sample: {ok}/{len(picked)} 段回原文一致')
def check_streams(m,root):
    chapters=bad=0; cj=[]
    for e in sorted(m['perBook']):
        d=book_dir(root,e)
        if not d: fail(f'字流校验：找不到书 {e}'); continue
        for p in sorted(glob.glob(d+'/default/*.md')):
            chapters+=1; o,n,_=stream(open(p,encoding='utf-8').read())
            if len(o)!=len(n): bad+=1; fail(f'{e}/{os.path.basename(p)} len(orig)!=len(norm)'); continue
            for i,(a,b) in enumerate(zip(o,n)):
                if b!=CMAP.get(a,a): bad+=1; fail(f'{e}/{os.path.basename(p)}[{i}] norm {b!r}≠charmap({a!r})'); break
    print(f'streams: {chapters} 章，{bad} 章有差异')
    # char.json 备查（不作门槛）：与同章 md 的 stream() 比对；无 md 的章只报长度
    for cp in sorted(glob.glob(f'{root}/*/*/*/*/*/default/*.char.json')):
        j=json.load(open(cp,encoding='utf-8')); cs=[]
        for pg in j.get('pages',[]):
            for col in pg.get('columns',[]):
                for c in col.get('cells',[]): cs.append(c.get('c',''))
        o,_,_=stream(''.join(cs)); mp=cp[:-len('.char.json')]+'.md'
        if os.path.exists(mp):
            so,_,_=stream(open(mp,encoding='utf-8').read())
            diff=sum(1 for a,b in zip(o,so) if a!=b)+abs(len(o)-len(so))
            cj.append(f'{os.path.relpath(cp,root)}: 差异 {diff}（char {len(o)} 字 / md {len(so)} 字）')
        else: cj.append(f'{os.path.relpath(cp,root)}: 无同章 md，无法对照（char 字流 {len(o)} 字）')
    print(f'char.json 备查（不作门槛）：共 {len(cj)} 个'); [print('  ',x) for x in cj]
def main():
    ap=argparse.ArgumentParser(); ap.add_argument('pack'); ap.add_argument('--text-root',default=os.environ.get('BOOK_TEXT'))
    ap.add_argument('--smoke',default=os.path.join(HERE,'..','contract','smoke_queries.json')); ap.add_argument('--sample',type=int,default=20)
    a=ap.parse_args()
    if not os.path.isfile(a.pack): print('ERROR[2] 包不存在',file=sys.stderr); sys.exit(2)
    with tempfile.TemporaryDirectory() as tmp:
        try:
            with tarfile.open(a.pack) as t: t.extractall(tmp,filter='data')
        except (tarfile.TarError,EOFError,OSError,zlib.error) as ex:
            print(f'ERROR[4] 包无法解开：{ex}',file=sys.stderr); sys.exit(4)
        mp=os.path.join(tmp,'manifest.json')
        if not os.path.isfile(mp): print('ERROR[4] 包内无 manifest.json',file=sys.stderr); sys.exit(4)
        m=json.load(open(mp,encoding='utf-8'))
        check_files(tmp,m)
        if not FAILS:
            ix=open_index(tmp)
            if os.path.isfile(a.smoke): check_smoke(ix,m,a.smoke)
            else: print('smoke: 无金标文件，跳过')
            if a.text_root and os.path.isdir(a.text_root):
                check_sample(ix,m,a.text_root,a.sample); check_streams(m,a.text_root)
            else: print('sample/streams: 未给 --text-root，跳过')
    if FAILS: print(f'verify 失败：{len(FAILS)} 项',file=sys.stderr); sys.exit(4)
    print('verify OK')
if __name__=='__main__': main()
