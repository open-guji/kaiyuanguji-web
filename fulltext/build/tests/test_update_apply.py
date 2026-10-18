"""F3 步 2：整本替换写入——改一本后增量结果须与全量重建逐段一致；注入故障旧索引 sha256 不变。"""
import hashlib,json,os,subprocess,sys
import pytest
HERE=os.path.dirname(os.path.abspath(__file__)); BUILD=os.path.dirname(HERE); ROOT=os.path.dirname(BUILD)
sys.path.insert(0,ROOT)
import tantivy
A,B,C='aaaaaaaaaaaa','bbbbbbbbbbbb','cccccccccccc'
T={A:'## 卷一\n\n'+'天地萬物之理，太極只是天地萬物之理。\n'*40,
   B:'## 卷一\n\n'+'學而時習之，不亦說乎。有朋自遠方來，不亦樂乎。\n'*40,
   C:'## 卷一\n\n'+'道可道，非常道。名可名，非常名。\n'*40}
def run(*a,env=None):
    e=dict(os.environ); e.update(env or {})
    return subprocess.run([sys.executable,'-I',*map(str,a)],capture_output=True,text=True,env=e)
def git(root,*a): return subprocess.run(['git','-C',root,*a],capture_output=True,text=True,check=True)
def write_book(root,eid,text):
    d=root/'Book'/'a'/'a'/'a'/eid/'default'; d.mkdir(parents=True,exist_ok=True)
    (d/'001.md').write_text(text,encoding='utf-8')
def labels(root,ids):
    (root/'index'/'texts').mkdir(parents=True,exist_ok=True)
    (root/'index'/'texts'/'a.json').write_text(json.dumps({e:[{'label':'書'+e[0]}] for e in ids},ensure_ascii=False))
def docs(d):
    ix=tantivy.Index.open(str(d/'index')); s=ix.searcher(); out=set()
    r=s.search(tantivy.Query.all_query(),s.num_docs)
    for _,a in r.hits:
        x=s.doc(a); out.add((x['entry'][0],x['label'][0],x['chapter'][0],x['start'][0],x['end'][0]))
    return out
def tree_sha(d):
    h=hashlib.sha256()
    for dp,_,fs in sorted(os.walk(d)):
        for f in sorted(fs):
            p=os.path.join(dp,f); h.update(p.encode()); h.update(open(p,'rb').read())
    return h.hexdigest()
@pytest.fixture
def fx(tmp_path):
    root=tmp_path/'bt'; root.mkdir(); git(root,'init','-q'); git(root,'config','user.email','t@t'); git(root,'config','user.name','t')
    for e in (A,B): write_book(root,e,T[e])
    labels(root,[A,B,C]); git(root,'add','-A'); git(root,'commit','-qm','init')
    cur=tmp_path/'cur'
    r=run(os.path.join(BUILD,'build_pack.py'),'--text-root',root,'--out',cur,'--only',A,B); assert r.returncode==0,r.stderr
    return root,cur,tmp_path
def update(root,cur,out,env=None):
    return run(os.path.join(BUILD,'update_books.py'),'--current',cur,'--text-root',root,'--out',out,env=env)
def full(root,tmp,name,only):
    o=tmp/name; r=run(os.path.join(BUILD,'build_pack.py'),'--text-root',root,'--out',o,'--only',*only); assert r.returncode==0,r.stderr; return o
def test_change_add_remove_equals_full(fx):
    root,cur,tmp=fx
    write_book(root,A,T[A]+'新增一段：太極圖說，無極而太極。\n'*20)   # 改 A
    write_book(root,C,T[C])                                           # 增 C
    import shutil; shutil.rmtree(root/'Book'/'a'/'a'/'a'/B)           # 删 B
    git(root,'add','-A'); git(root,'commit','-qm','chg')
    out=tmp/'new'; r=update(root,cur,out); assert r.returncode==0,r.stdout+r.stderr
    ref=full(root,tmp,'ref',[A,C])
    assert docs(out)==docs(ref)
    m=json.load(open(out/'manifest.json')); mr=json.load(open(ref/'manifest.json'))
    assert set(m['perBook'])==set(mr['perBook']) and m['passages']==mr['passages'] and m['chapters']==mr['chapters']
    assert {e:v['passages'] for e,v in m['perBook'].items()}=={e:v['passages'] for e,v in mr['perBook'].items()}
    assert {e:v['commit'] for e,v in m['perBook'].items()}=={e:v['commit'] for e,v in mr['perBook'].items()}
    assert m['incremental'] and m['incrementalCount']==1
    assert json.load(open(out/'titles.json'))==json.load(open(ref/'titles.json'))
    for rel,info in m['files'].items():   # manifest 里每个文件 sha256 属实
        h=hashlib.sha256(open(out/rel,'rb').read()).hexdigest(); assert h==info['sha256'],rel
@pytest.mark.parametrize('where',['after_delete','after_commit'])
def test_injected_failure_leaves_old_untouched(fx,where):
    root,cur,tmp=fx
    write_book(root,A,T[A]+'改动。\n'*30); git(root,'add','-A'); git(root,'commit','-qm','chg')
    before=tree_sha(cur); out=tmp/'new'
    r=update(root,cur,out,env={'FT_FAIL_AT':where})
    assert r.returncode==8,r.stdout+r.stderr
    assert not out.exists() and tree_sha(cur)==before
def test_no_change_no_out(fx):
    root,cur,tmp=fx; out=tmp/'new'
    r=update(root,cur,out); assert r.returncode==0 and not out.exists()
def test_out_exists_refused(fx):
    root,cur,tmp=fx
    write_book(root,A,T[A]+'x\n'*30); git(root,'add','-A'); git(root,'commit','-qm','c')
    out=tmp/'new'; out.mkdir()
    assert update(root,cur,out).returncode==2
def test_too_many_changes_exit7(fx):
    root,cur,tmp=fx
    for e in (A,B): write_book(root,e,T[e]+'改。\n'*30)
    git(root,'add','-A'); git(root,'commit','-qm','c')
    out=tmp/'new'
    r=run(os.path.join(BUILD,'update_books.py'),'--current',cur,'--text-root',root,'--out',out,'--limit','1')
    assert r.returncode==7 and not out.exists()
