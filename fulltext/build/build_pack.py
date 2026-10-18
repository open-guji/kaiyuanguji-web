"""建全文索引包（v2，设计见 fulltext/docs/design.md）。
产出索引包 fulltext-<stamp>.tar.gz（index/、titles.json、boost.json、chapters.json、manifest.json）。
v2 索引：norm 双字带位置＋norm1 单字频次（不再建 orig／orig1）；每段原文存进索引（text，只存不索引），
服务端不再读 book-text；entry 为快字段（按书聚合计数），ord＝书内段序（快字段，书内按原文顺序取段），
long＝所在章 ≥30 字（短章降权）。
chapters.json＝{书ID:{章:原始字节sha256}}，登记在 manifest.files，manifest.chapterSha256File 指向它（可选，旧包没有）。
用法: build_pack.py [--text-root DIR] [--book-index DIR] --out DIR [--only ENTRY ...] [--prev-books N] [--need-gb G]
退出码: 0 成功；2 参数错；3 book-text 不可用；4 校验失败；5 磁盘不足。
原文来源：default/<章>.md 字流（方案 a）；char.json 只登记覆盖率（charChapters／charCoverage），
fallbackChapters＝无 char.json 的章数，不参与切段。"""
import argparse,datetime,glob,hashlib,json,os,re,resource,shutil,subprocess,sys,tarfile,time
from multiprocessing import Pool
from zoneinfo import ZoneInfo
HERE=os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0,os.path.dirname(HERE))  # common.py 在上一级
import tantivy
from common import passages,stream
SCHEMA_VERSION=2
SHORT_CHAPTER=30   # 章总长（码点）小于此为短章，排序降权；与 service/ranking.py 同值
CHARMAP=os.path.join(os.path.dirname(HERE),'charmap.json')
CHARMAP_ENTRIES=4820
def die(code,msg):
    print(f'ERROR[{code}] {msg}',file=sys.stderr); sys.exit(code)
def sha256_file(p):
    h=hashlib.sha256()
    with open(p,'rb') as f:
        for b in iter(lambda:f.read(1<<20),b''): h.update(b)
    return h.hexdigest()
def toks(s,k):
    if k==1 or len(s)<2: return ' '.join(s)
    return ' '.join(s[i:i+2] for i in range(len(s)-1))
def book_dirs(root):
    loc={}
    for top in ('Work','Book'):
        for d in glob.glob(f'{root}/{top}/*/*/*/*'):
            loc[os.path.basename(d)]=d
    return loc
TITLE_FILE=re.compile(r'^([0-9A-Za-z]{12})-(.+)\.json$')
def titles_from_book_index(book_index):
    """书名表 {书ID: 书名}，取自 book-index 的文件名 `<ID>-<书名>.json`（Work／Book／Collection）。
    是 git 检出时用 ls-tree，只读树不下 blob（blobless 克隆即可）；否则遍历目录。没给目录返回空表。"""
    if not book_index: return {}
    names=[]
    r=subprocess.run(['git','-C',book_index,'ls-tree','-r','-z','--name-only','HEAD','--','Work','Book','Collection'],
                     capture_output=True,text=True)
    if r.returncode==0: names=[os.path.basename(p) for p in r.stdout.split('\0') if p]
    else:
        for top in ('Work','Book','Collection'):
            for _,_,fs in os.walk(os.path.join(book_index,top)): names+=fs
    out={}
    for n in names:
        m=TITLE_FILE.match(n)
        if m: out[m.group(1)]=m.group(2)
    return out
def book_titles(ids,labels,title_map):
    """包里的 titles.json：优先 book-index 书名；查不到的退回 book-text 版本名并告警。"""
    miss=[e for e in ids if e not in title_map]
    if title_map and miss: print(f'WARN: {len(miss)} 部书在 book-index 里查不到书名，用版本名代替：{miss[:5]}',file=sys.stderr)
    if not title_map: print('WARN: 未给 --book-index，titles.json 只有版本名（如「維基文庫」），不能上线',file=sys.stderr)
    return {e:title_map.get(e) or labels[e] for e in ids}
def entries_from_index(root):
    labels={}
    for f in glob.glob(f'{root}/index/texts/*.json'):
        for eid,vs in json.load(open(f)).items():
            labels[eid]=vs[0]['label']
    return labels
def chapter_docs(eid,chapter,md,ord0=0):
    """一章 → 索引文档列表（v2 字段）。ord 从 ord0 起连续编号（书内段序）。nchar 只用于统计，写入前弹出。"""
    long_=int(len(md)>=SHORT_CHAPTER); out=[]
    for s,e,h in passages(md):
        raw=md[s:e]
        o,n,_=stream(raw)
        if not o: continue
        r=dict(norm=toks(''.join(n),2),norm1=' '.join(n),entry=eid,chapter=chapter,start=s,end=e,
               ord=ord0+len(out),long=long_,text=raw.encode('utf-8'),nchar=len(o))
        if h: r['label']=h
        out.append(r)
    return out
# 子进程：全局只读，由 fork 继承
LOC={}
def work(eid):
    d=LOC.get(eid); res=[]; chapters=0; withchar=0; shas={}; crs=[]; ordn=0
    if not d or not os.path.isdir(d+'/default'): return eid,res,chapters,withchar,shas,crs
    for f in sorted(os.listdir(d+'/default')):
        if not f.endswith('.md'): continue
        chapters+=1
        if os.path.exists(f'{d}/default/{f[:-3]}.char.json'): withchar+=1
        raw=open(f'{d}/default/{f}','rb').read()
        # 偏移基线＝Python 通用换行后的码点；book-text 现无 \r（GUJI-163 普查 0/114882），出现即由主进程判红
        if b'\r' in raw: crs.append(f[:-3])
        shas[f[:-3]]=hashlib.sha256(raw).hexdigest()   # 原始字节 sha256，供下游核对章是否被改
        md=raw.decode('utf-8').replace('\r\n','\n').replace('\r','\n')
        docs=chapter_docs(eid,f[:-3],md,ordn)
        res+=docs; ordn+=len(docs)
    return eid,res,chapters,withchar,shas,crs
REQUIRED={'schemaVersion':int,'stamp':str,'createdAtEpoch':int,'bookTextCommit':(str,type(None)),'charmapSha256':str,'charmapEntries':int,
          'indexerVersion':str,'books':int,'passages':int,'chapters':int,'charChapters':int,'fallbackChapters':int,
          'originalSource':str,'charCoverage':float,'indexBytes':int,'files':dict,'perBook':dict,'build':dict}
def check_manifest(m):
    bad=[k for k,t in REQUIRED.items() if k not in m or not isinstance(m[k],t)]
    if bad: die(4,f'manifest 字段缺失或类型错：{bad}')
    if m['schemaVersion']!=SCHEMA_VERSION: die(4,f'schemaVersion {m["schemaVersion"]} ≠ {SCHEMA_VERSION}')
def build_schema():
    """v2 字段。整数一律 i64（tantivy.Document 把 Python int 当 i64，用 unsigned 会在写入时报类型错）。"""
    sb=tantivy.SchemaBuilder()
    sb.add_text_field('norm',stored=False,tokenizer_name='whitespace',index_option='position')
    sb.add_text_field('norm1',stored=False,tokenizer_name='whitespace',index_option='freq')
    sb.add_text_field('entry',stored=True,tokenizer_name='raw',index_option='basic',fast=True)
    sb.add_text_field('label',stored=True,tokenizer_name='raw',index_option='basic')
    sb.add_text_field('chapter',stored=True,tokenizer_name='raw',index_option='basic')
    sb.add_integer_field('start',stored=True,indexed=False); sb.add_integer_field('end',stored=True,indexed=False)
    sb.add_integer_field('ord',stored=False,indexed=False,fast=True)
    sb.add_integer_field('long',stored=True,indexed=False,fast=True)
    sb.add_bytes_field('text',stored=True,indexed=False)
    return sb.build()
def main():
    ap=argparse.ArgumentParser()
    ap.add_argument('--text-root',default=os.environ.get('BOOK_TEXT',os.path.join(HERE,'..','..','..','book-text')))
    ap.add_argument('--out',required=True)
    ap.add_argument('--book-index',default=os.environ.get('BOOK_INDEX'),help='book-index 检出（可 blobless），取书名')
    ap.add_argument('--only',nargs='+',default=None)
    ap.add_argument('--prev-books',type=int,default=None)
    ap.add_argument('--need-gb',type=float,default=None)
    ap.add_argument('--procs',type=int,default=int(os.environ.get('FT_PROCS','3')))
    a=ap.parse_args()
    t0=time.time()
    root=os.path.abspath(a.text_root)
    if not os.path.isdir(f'{root}/index/texts'): die(3,f'book-text 不可用：{root}/index/texts 不存在')
    # ① charmap 条目数
    cmap=json.load(open(CHARMAP,encoding='utf-8'))
    if len(cmap)!=CHARMAP_ENTRIES: die(4,f'charmap 条目数 {len(cmap)} ≠ {CHARMAP_ENTRIES}')
    # ② 书单
    global LOC
    LOC=book_dirs(root)
    labels=entries_from_index(root)
    ids=sorted(labels)
    if a.only:
        want=[x.strip() for part in a.only for x in part.split(',') if x.strip()]
        ids=[i for i in want if i in labels]
        if len(ids)!=len(want): print(f'WARN: {len(want)-len(ids)} 个 ID 不在 index/texts',file=sys.stderr)
    # ③ 磁盘
    need=a.need_gb if a.need_gb is not None else (0.5 if a.only else 8.8)
    os.makedirs(a.out,exist_ok=True)
    free=shutil.disk_usage(a.out).free/1e9
    if free<need*1.2: die(5,f'磁盘不足：可用 {free:.1f} GB < 估算峰值 {need} GB ×1.2')
    # ④ 切段＋写入
    out_idx=os.path.join(a.out,'index')
    shutil.rmtree(out_idx,ignore_errors=True); os.makedirs(out_idx)
    idx=tantivy.Index(build_schema(),path=out_idx)
    w=idx.writer(heap_size=int(os.environ.get('FT_HEAP_MB','1500'))*1_000_000,num_threads=int(os.environ.get('FT_THREADS','3')))
    np=nc=nchap=nchar=0; per_book={}; books_ok=0; chap_sha={}; cr_found=[]
    with Pool(a.procs) as pool:
        for eid,res,chapters,withchar,shas,crs in pool.imap_unordered(work,ids,chunksize=1):
            nchap+=chapters; nchar+=withchar
            if shas: chap_sha[eid]=shas
            cr_found+=[f'{eid}/{c}' for c in crs]
            if res: books_ok+=1
            for r in res:
                nc+=r.pop('nchar'); w.add_document(tantivy.Document(**r)); np+=1
            per_book[eid]=len(res)
    t1=time.time(); w.commit(); w.wait_merging_threads()
    # ⑤ 校验
    if cr_found: die(4,f'default/*.md 含 \\r 共 {len(cr_found)} 章（偏移基线假设无 \\r，需先决定换行处理）：{cr_found[:5]}')
    if np==0: die(4,'段数为 0')
    if a.prev_books and books_ok<0.9*a.prev_books: die(4,f'书数 {books_ok} 低于上次 {a.prev_books} 的 90%')
    # ⑥ 元数据
    stamp=datetime.datetime.now(ZoneInfo('America/Los_Angeles')).strftime('%Y%m%d-%H%M')
    commit=subprocess.run(['git','-C',root,'rev-parse','HEAD'],capture_output=True,text=True).stdout.strip() or None
    def last_commit(eid):
        d=LOC.get(eid)
        if not d: return None
        rel=os.path.relpath(d,root)
        r=subprocess.run(['git','-C',root,'log','-1','--format=%H','--',rel],capture_output=True,text=True)
        return r.stdout.strip() or None
    titles=book_titles([e for e in sorted(per_book) if per_book[e]>0],labels,titles_from_book_index(a.book_index))
    with open(os.path.join(a.out,'titles.json'),'w',encoding='utf-8') as f: json.dump(titles,f,ensure_ascii=False)
    with open(os.path.join(a.out,'boost.json'),'w',encoding='utf-8') as f: json.dump({},f)
    with open(os.path.join(a.out,'chapters.json'),'w',encoding='utf-8') as f: json.dump(chap_sha,f,ensure_ascii=False,separators=(',',':'),sort_keys=True)
    files={}
    for p in sorted(glob.glob(os.path.join(out_idx,'**','*'),recursive=True)+[os.path.join(a.out,'titles.json'),os.path.join(a.out,'boost.json'),os.path.join(a.out,'chapters.json')]):
        if os.path.isfile(p):
            rel=os.path.relpath(p,a.out); files[rel]=dict(bytes=os.path.getsize(p),sha256=sha256_file(p))
    index_bytes=sum(v['bytes'] for k,v in files.items() if k.startswith('index'))
    indexer=hashlib.sha256()
    for s in (__file__,os.path.join(HERE,'..','common.py')): indexer.update(open(s,'rb').read())
    # 原文来源：现行为 default/<章>.md 字流（Eden 2026-10-12 定方案 a）；char.json 仅登记覆盖率，不参与切段
    coverage=nchar/nchap if nchap else 0.0
    if coverage<0.8: print(f'WARN: char.json 覆盖率 {coverage:.2%} < 80%，按设计需报卡',file=sys.stderr)
    manifest=dict(schemaVersion=SCHEMA_VERSION,stamp=stamp,createdAtEpoch=int(time.time()),
        bookTextCommit=commit,charmapSha256=sha256_file(CHARMAP),charmapEntries=len(cmap),
        indexerVersion=indexer.hexdigest(),
        books=books_ok,passages=np,chapters=nchap,charChapters=nchar,fallbackChapters=nchap-nchar,
        originalSource='default-md',charCoverage=round(coverage,6),indexBytes=index_bytes,
        files=files,chapterSha256File='chapters.json',
        perBook={e:dict(passages=per_book[e],commit=last_commit(e)) for e in per_book if per_book[e]>0},
        build=dict(seconds=round(time.time()-t0),peakRssMB=resource.getrusage(resource.RUSAGE_SELF).ru_maxrss//1024,
                   peakDiskGB=round(sum(os.path.getsize(p) for p in glob.glob(out_idx+'/**/*',recursive=True) if os.path.isfile(p))/1e9,3)))
    check_manifest(manifest)
    manifest_path=os.path.join(a.out,'manifest.json')
    with open(manifest_path,'w',encoding='utf-8') as f: json.dump(manifest,f,ensure_ascii=False,indent=1)
    tar=os.path.join(a.out,f'fulltext-{stamp}.tar.gz')
    with tarfile.open(tar,'w:gz') as t:
        for name in ('index','titles.json','boost.json','chapters.json','manifest.json'): t.add(os.path.join(a.out,name),arcname=name)
    print(f'books={books_ok} passages={np} chars={nc} chapters={nchap} commit={commit} stamp={stamp}')
    print(f'build: 读+切+加 {t1-t0:.0f}s, commit+merge {time.time()-t1:.0f}s, 总 {time.time()-t0:.0f}s, peakRSS {manifest["build"]["peakRssMB"]}MB')
    print(f'pack: {tar}')
if __name__=='__main__':
    main()
