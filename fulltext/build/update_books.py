"""F3：增量更新——步 1 变更集计算；步 2 整本替换写入＋校验＋失败回滚。
用法: update_books.py --current DIR --text-root DIR [--out DIR] [--limit 200]
  不给 --out：只打印变更集 JSON（步 1）。给 --out：硬链接复制 --current 到 --out（须同分区），
  对 changed+removed 先按 entry 删旧段，再对 changed+added 用 build_pack 同一套切段重写，写新 manifest，校验；
  任何异常或校验失败 → 删除 --out、退出 8，--current 一字节不动（硬链接的段文件 tantivy 从不原地改写）。
变更集：对每本书比较旧 manifest 的 perBook.commit 与 book-text 中该书最后变更提交——
不同＝changed；新有旧无＝added；旧有新无＝removed；changed+added+removed > limit(200) 拒绝增量（退出码 7）。
退出码: 0 成功；2 参数错；3 manifest 与索引不一致；7 变更过多（改做全量）；8 验证失败。"""
import argparse,glob,json,os,shutil,subprocess,sys,time
HERE=os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0,HERE); sys.path.insert(0,os.path.dirname(HERE))
LIMIT=200
def die(code,msg):
    print(f'ERROR[{code}] {msg}',file=sys.stderr); sys.exit(code)
def compute_changes(old_per_book,new_commits,limit=LIMIT):
    """old_per_book: manifest['perBook']（entry->{passages,commit}）；
    new_commits: entry->book-text 中该书最后变更提交（无正文的书不应出现）。
    返回 dict(changed,added,removed 皆为排序后的 ID 列表)；总数超 limit 抛 TooMany。"""
    old=set(old_per_book); new=set(new_commits)
    added=sorted(new-old); removed=sorted(old-new)
    changed=sorted(e for e in old&new if old_per_book[e].get('commit')!=new_commits[e])
    n=len(added)+len(removed)+len(changed)
    if n>limit: raise TooMany(n,limit)
    return dict(changed=changed,added=added,removed=removed)
class TooMany(Exception):
    def __init__(self,n,limit): super().__init__(f'变更 {n} 本 > {limit}，改做全量'); self.n=n; self.limit=limit
def book_dirs(root):
    loc={}
    for top in ('Work','Book'):
        for d in glob.glob(f'{root}/{top}/*/*/*/*'):
            if os.path.isdir(d+'/default'): loc[os.path.basename(d)]=d
    return loc
def current_commits(root,old_per_book=None,old_commit=None):
    """每本书最后变更提交。有旧 bookTextCommit 且可达时：只对 git diff 出的书重算，其余沿用旧值（快）；
    否则逐书 git log（全量，慢，仅兜底）。"""
    loc=book_dirs(root); res={}
    def last(eid):
        rel=os.path.relpath(loc[eid],root)
        r=subprocess.run(['git','-C',root,'log','-1','--format=%H','--',rel],capture_output=True,text=True)
        return r.stdout.strip() or None
    touched=None
    if old_per_book and old_commit:
        r=subprocess.run(['git','-C',root,'diff','--name-only',f'{old_commit}..HEAD'],capture_output=True,text=True)
        if r.returncode==0:
            touched=set()
            for p in r.stdout.splitlines():
                parts=p.split('/')
                if len(parts)>=5 and parts[0] in ('Work','Book'): touched.add(parts[4])
    for eid in loc:
        if touched is not None and eid not in touched and eid in old_per_book:
            res[eid]=old_per_book[eid]['commit']
        else:
            c=last(eid)
            if c: res[eid]=c
    return res
def link_tree(src,dst):
    """硬链接复制目录（同分区）；跨分区则退化为拷贝。"""
    def cp(a,b):
        try: os.link(a,b)
        except OSError: shutil.copy2(a,b)
    shutil.copytree(src,dst,copy_function=cp)
def count_entry(ix,eid):
    import tantivy
    ix.reload()
    q=tantivy.Query.term_query(ix.schema,'entry',eid)
    return ix.searcher().search(q,1,count=True).count
def apply_update(current,root,out,ch,m):
    """返回新 manifest。失败抛异常，由调用方清理 out。"""
    import tantivy,build_pack as bp
    bp.LOC=bp.book_dirs(root)
    labels=bp.entries_from_index(root)
    os.makedirs(out)
    link_tree(os.path.join(current,'index'),os.path.join(out,'index'))
    idx=tantivy.Index.open(os.path.join(out,'index'))
    w=idx.writer(heap_size=int(os.environ.get('FT_HEAP_MB','500'))*1_000_000,num_threads=int(os.environ.get('FT_THREADS','2')))
    for eid in ch['changed']+ch['removed']: w.delete_documents_by_term('entry',eid)
    if os.environ.get('FT_FAIL_AT')=='after_delete': raise RuntimeError('注入故障：删除之后')
    per={e:dict(v) for e,v in m['perBook'].items()}
    for eid in ch['removed']: per.pop(eid,None)
    for eid in ch['changed']+ch['added']:
        _,res,_,_,_,crs=bp.work(eid)
        if crs: raise RuntimeError(f'{eid} 含 \\r 的章：{crs[:5]}（偏移基线假设无 \\r）')
        if eid not in labels: raise RuntimeError(f'{eid} 不在 index/texts')
        for r in res:
            r.pop('nchar'); r['label']=labels[eid]; w.add_document(tantivy.Document(**r))
        per[eid]=dict(passages=len(res),commit=None)
    w.commit(); w.wait_merging_threads()
    if os.environ.get('FT_FAIL_AT')=='after_commit': raise RuntimeError('注入故障：提交之后')
    return idx,per
def finish(current,root,out,ch,m,idx,per,new_commits,t0):
    import build_pack as bp
    for eid in ch['changed']+ch['added']:
        if per[eid]['passages']==0: per.pop(eid)   # 无正文＝不入索引（与全量一致）
        else: per[eid]['commit']=new_commits[eid]
    labels=bp.entries_from_index(root)
    titles={e:labels[e] for e in per}
    with open(os.path.join(out,'titles.json'),'w',encoding='utf-8') as f: json.dump(titles,f,ensure_ascii=False)
    shutil.copy2(os.path.join(current,'boost.json'),os.path.join(out,'boost.json'))
    # 章数从磁盘数（便宜）
    loc=bp.LOC; nchap=nchar=0
    for e in per:
        d=loc.get(e)
        for f in os.listdir(d+'/default'):
            if f.endswith('.md'):
                nchap+=1; nchar+=os.path.exists(f'{d}/default/{f[:-3]}.char.json')
    files={}
    old_files=m['files']
    for p in sorted(glob.glob(os.path.join(out,'index','**','*'),recursive=True)+[os.path.join(out,'titles.json'),os.path.join(out,'boost.json')]):
        if not os.path.isfile(p): continue
        rel=os.path.relpath(p,out); old=os.path.join(current,rel)
        if rel in old_files and os.path.exists(old) and os.path.samefile(old,p):
            files[rel]=old_files[rel]           # 同 inode＝未改动，沿用旧 sha256
        else: files[rel]=dict(bytes=os.path.getsize(p),sha256=bp.sha256_file(p))
    nm=json.loads(json.dumps(m))
    commit=subprocess.run(['git','-C',root,'rev-parse','HEAD'],capture_output=True,text=True).stdout.strip() or None
    npass=sum(v['passages'] for v in per.values())
    import datetime
    from zoneinfo import ZoneInfo
    nm.update(stamp=datetime.datetime.now(ZoneInfo('America/Los_Angeles')).strftime('%Y%m%d-%H%M'),
        createdAtEpoch=int(time.time()),bookTextCommit=commit,books=len(per),passages=npass,
        chapters=nchap,charChapters=nchar,fallbackChapters=nchap-nchar,
        charCoverage=round(nchar/nchap,6) if nchap else 0.0,
        indexBytes=sum(v['bytes'] for k,v in files.items() if k.startswith('index')),
        files=files,perBook=per)
    nm['incremental']=True
    nm['incrementalCount']=m.get('incrementalCount',0)+1
    nm['lastIncremental']=dict(changed=ch['changed'],added=ch['added'],removed=ch['removed'],seconds=round(time.time()-t0))
    bp.check_manifest(nm)
    # 校验：总段数、每本书段数与 manifest 一致；removed 为 0
    import tantivy
    ix=tantivy.Index.open(os.path.join(out,'index')); ix.reload()
    total=ix.searcher().num_docs
    if total!=npass: raise RuntimeError(f'索引总段数 {total} ≠ manifest {npass}')
    for eid in ch['changed']+ch['added']:
        got=count_entry(ix,eid)
        if got!=per.get(eid,{}).get('passages',0): raise RuntimeError(f'{eid} 段数 {got} ≠ {per.get(eid,{}).get("passages",0)}')
    for eid in ch['removed']:
        if count_entry(ix,eid)!=0: raise RuntimeError(f'已删除的书 {eid} 仍有残段')
    with open(os.path.join(out,'manifest.json'),'w',encoding='utf-8') as f: json.dump(nm,f,ensure_ascii=False,indent=1)
    return nm
def main():
    ap=argparse.ArgumentParser()
    ap.add_argument('--current',required=True,help='当前生效索引目录（含 manifest.json）')
    ap.add_argument('--text-root',required=True)
    ap.add_argument('--out',default=None,help='新索引目录（不存在）；不给则只打印变更集')
    ap.add_argument('--limit',type=int,default=LIMIT)
    a=ap.parse_args()
    mp=os.path.join(a.current,'manifest.json')
    if not os.path.isfile(mp): die(3,f'{mp} 不存在')
    m=json.load(open(mp,encoding='utf-8'))
    if 'perBook' not in m: die(3,'manifest 缺 perBook')
    new=current_commits(os.path.abspath(a.text_root),m['perBook'],m.get('bookTextCommit'))
    try: ch=compute_changes(m['perBook'],new,a.limit)
    except TooMany as e: die(7,str(e))
    print(json.dumps(ch,ensure_ascii=False))
    if not a.out: return
    if not (ch['changed'] or ch['added'] or ch['removed']):
        print('无变更，不生成新索引'); return
    if os.path.exists(a.out): die(2,f'--out {a.out} 已存在')
    if m.get('incrementalCount',0)+1>=20: print('WARN: 增量已达 20 次，建议下一轮做全量',file=sys.stderr)
    t0=time.time(); root=os.path.abspath(a.text_root)
    try:
        idx,per=apply_update(a.current,root,a.out,ch,m)
        nm=finish(a.current,root,a.out,ch,m,idx,per,new,t0)
    except BaseException as e:
        shutil.rmtree(a.out,ignore_errors=True)
        die(8,f'增量失败，已丢弃新目录，旧索引未动：{type(e).__name__}: {e}')
    print(f'incremental OK: changed={len(ch["changed"])} added={len(ch["added"])} removed={len(ch["removed"])} books={nm["books"]} passages={nm["passages"]} {time.time()-t0:.0f}s')
if __name__=='__main__':
    main()
