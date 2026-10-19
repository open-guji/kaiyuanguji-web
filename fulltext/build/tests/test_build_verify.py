"""build_pack／verify_pack 测试：造一个微型 book-text，构建→校验→篡改→必须退出 4。"""
import json,os,shutil,subprocess,sys,tarfile
import pytest
HERE=os.path.dirname(os.path.abspath(__file__)); BUILD=os.path.dirname(HERE)
ROOT=os.path.dirname(BUILD)
sys.path.insert(0,ROOT)
from common import CMAP,stream,passages,query_stream
EID='aaaaaaaaaaaa'
TEXT1='## 卷一\n\n'+'天地萬物之理，太極只是天地萬物之理。\n'*40
TEXT2='## 卷二\n\n'+'學而時習之，不亦說乎。有朋自遠方來，不亦樂乎。\n'*40
def gold(q,field):
    qo,qn=query_stream(q); q=qn if field=='norm' else qo; n=0
    for t in (TEXT1,TEXT2):
        for a,b,_ in passages(t):
            o,nn,_=stream(t[a:b]); n+=q in ''.join(nn if field=='norm' else o)
    return n
def run(*args,**kw): return subprocess.run([sys.executable,'-I',*map(str,args)],capture_output=True,text=True,**kw)
@pytest.fixture(scope='module')
def fx(tmp_path_factory):
    root=tmp_path_factory.mktemp('bt')
    d=root/'Book'/'a'/'a'/'a'/EID/'default'; d.mkdir(parents=True)
    (d/'001.md').write_text(TEXT1,encoding='utf-8'); (d/'002.md').write_text(TEXT2,encoding='utf-8')
    (root/'index'/'texts').mkdir(parents=True)
    (root/'index'/'texts'/'a.json').write_text(json.dumps({EID:[{'label':'測試書'}]},ensure_ascii=False))
    out=tmp_path_factory.mktemp('out')
    r=run(os.path.join(BUILD,'build_pack.py'),'--text-root',root,'--out',out,'--only',EID)
    assert r.returncode==0,r.stderr
    pack=[p for p in os.listdir(out) if p.endswith('.tar.gz')][0]
    return root,out,out/pack
@pytest.fixture
def smoke(tmp_path):
    p=tmp_path/'smoke.json'
    p.write_text(json.dumps([{'id':'a','entry':EID,'field':'norm','q':'太極','note':'','expect':gold('太極','norm')},
                             {'id':'b','entry':EID,'field':'orig','q':'學而時習','note':'','expect':gold('學而時習','orig')},
                             {'id':'c','entry':EID,'field':'norm','q':'龘龘龘','note':'','expect':0}],ensure_ascii=False))
    return p
def test_manifest_fields(fx):
    _,out,_=fx; m=json.load(open(out/'manifest.json'))
    assert m['books']==1 and m['passages']==sum(len(passages(t)) for t in (TEXT1,TEXT2)) and m['charmapEntries']==5255
    assert m['perBook'][EID]['passages']==m['passages'] and m['fallbackChapters']==2 and m['charCoverage']==0.0
    assert all(len(v['sha256'])==64 for v in m['files'].values())
def test_chapter_sha256(fx):
    import hashlib
    root,out,pack=fx; m=json.load(open(out/'manifest.json'))
    assert m['chapterSha256File']=='chapters.json' and 'chapters.json' in m['files']
    assert 'charmap.json' in m['files']   # 归一表随包走
    c=json.load(open(out/'chapters.json'))
    assert c=={EID:{'001':hashlib.sha256(TEXT1.encode()).hexdigest(),'002':hashlib.sha256(TEXT2.encode()).hexdigest()}}
    with tarfile.open(pack) as t: assert 'chapters.json' in t.getnames()
def test_build_fails_on_cr(tmp_path):
    root=tmp_path/'bt'; d=root/'Book'/'a'/'a'/'a'/EID/'default'; d.mkdir(parents=True)
    (d/'001.md').write_bytes(TEXT1.replace('\n','\r\n').encode())
    (root/'index'/'texts').mkdir(parents=True)
    (root/'index'/'texts'/'a.json').write_text(json.dumps({EID:[{'label':'測試書'}]},ensure_ascii=False))
    r=run(os.path.join(BUILD,'build_pack.py'),'--text-root',root,'--out',tmp_path/'o','--only',EID)
    assert r.returncode==4 and '\\r' in r.stderr
def test_verify_ok(fx,smoke):
    root,_,pack=fx
    r=run(os.path.join(BUILD,'verify_pack.py'),pack,'--text-root',root,'--smoke',smoke,'--sample','5')
    assert r.returncode==0,r.stdout+r.stderr
    assert 'verify OK' in r.stdout and 'streams: 2 章，0 章有差异' in r.stdout
def test_smoke_gold_mismatch(fx,smoke):
    root,_,pack=fx; g=json.load(open(smoke)); g[0]['expect']+=1; json.dump(g,open(smoke,'w'))
    r=run(os.path.join(BUILD,'verify_pack.py'),pack,'--text-root',root,'--smoke',smoke)
    assert r.returncode==4
def test_tamper_one_byte(fx,smoke,tmp_path):
    root,_,pack=fx; x=tmp_path/'x'; x.mkdir()
    with tarfile.open(pack) as t: t.extractall(x,filter='data')
    f=x/'titles.json'; b=bytearray(f.read_bytes()); b[-3]^=1; f.write_bytes(bytes(b))
    bad=tmp_path/'bad.tar.gz'
    with tarfile.open(bad,'w:gz') as t:
        for n in ('index','titles.json','boost.json','chapters.json','manifest.json'): t.add(x/n,arcname=n)
    r=run(os.path.join(BUILD,'verify_pack.py'),bad,'--smoke',smoke)
    assert r.returncode==4 and 'sha256 不符 titles.json' in r.stdout
def test_corrupt_gzip(fx,tmp_path):
    _,_,pack=fx; b=bytearray(open(pack,'rb').read()); b[len(b)//2]^=0xff
    bad=tmp_path/'c.tar.gz'; bad.write_bytes(bytes(b))
    assert run(os.path.join(BUILD,'verify_pack.py'),bad).returncode==4
def test_missing_pack(tmp_path):
    assert run(os.path.join(BUILD,'verify_pack.py'),tmp_path/'nope.tar.gz').returncode==2
def test_stream_norm_is_charmap_of_orig():
    s='天地萬物之理，說乎 abc〇□'
    o,n,_=stream(s)
    assert len(o)==len(n) and all(b==CMAP.get(a,a) for a,b in zip(o,n))
def test_build_exit3_when_no_index(tmp_path):
    r=run(os.path.join(BUILD,'build_pack.py'),'--text-root',tmp_path,'--out',tmp_path/'o')
    assert r.returncode==3
def test_titles_from_book_index_dir_and_fallback(tmp_path,capsys):
    sys.path.insert(0,BUILD); import build_pack as bp
    (tmp_path/'Work'/'a'/'a'/'a').mkdir(parents=True)
    (tmp_path/'Work'/'a'/'a'/'a'/f'{EID}-測試書名.json').write_text('{}')
    (tmp_path/'Book'/'b').mkdir(parents=True)
    (tmp_path/'Book'/'b'/'notes.json').write_text('{}')          # 不合 ID-书名 格式的忽略
    m=bp.titles_from_book_index(str(tmp_path))
    assert m=={EID:'測試書名'}
    t=bp.book_titles([EID,'bbbbbbbbbbbb'],{EID:'維基文庫','bbbbbbbbbbbb':'維基文庫'},m)
    assert t=={EID:'測試書名','bbbbbbbbbbbb':'維基文庫'} and 'WARN' in capsys.readouterr().err
