import os,sys,subprocess,pytest
sys.path.insert(0,os.path.join(os.path.dirname(__file__),'..'))
from update_books import compute_changes,TooMany,current_commits
def pb(**kw): return {k:dict(passages=1,commit=v) for k,v in kw.items()}
def test_no_change():
    assert compute_changes(pb(a='1',b='2'),{'a':'1','b':'2'})==dict(changed=[],added=[],removed=[])
def test_changed_one():
    assert compute_changes(pb(a='1',b='2'),{'a':'1','b':'9'})==dict(changed=['b'],added=[],removed=[])
def test_added_one():
    assert compute_changes(pb(a='1'),{'a':'1','c':'3'})==dict(changed=[],added=['c'],removed=[])
def test_removed_one():
    assert compute_changes(pb(a='1',b='2'),{'a':'1'})==dict(changed=[],added=[],removed=['b'])
def test_too_many():
    old=pb(**{f'b{i}':'1' for i in range(300)}); new={f'b{i}':'2' for i in range(300)}
    with pytest.raises(TooMany): compute_changes(old,new)
def test_limit_boundary():
    old=pb(**{f'b{i}':'1' for i in range(200)}); new={f'b{i}':'2' for i in range(200)}
    assert len(compute_changes(old,new)['changed'])==200
def _git(d,*a): return subprocess.run(['git','-C',str(d),*a],check=True,capture_output=True,text=True).stdout.strip()
def test_current_commits_incremental(tmp_path):
    r=tmp_path
    _git(r,'init','-q'); _git(r,'config','user.email','t@t'); _git(r,'config','user.name','t')
    for e in ('aaaaaaaaaaaa','bbbbbbbbbbbb'):
        d=r/'Book'/'a'/'b'/'c'/e/'default'; d.mkdir(parents=True); (d/'001.md').write_text('x')
    _git(r,'add','.'); _git(r,'commit','-qm','1'); c1=_git(r,'rev-parse','HEAD')
    full=current_commits(str(r))
    assert set(full)=={'aaaaaaaaaaaa','bbbbbbbbbbbb'} and set(full.values())=={c1}
    (r/'Book'/'a'/'b'/'c'/'bbbbbbbbbbbb'/'default'/'001.md').write_text('y')
    _git(r,'commit','-qam','2'); c2=_git(r,'rev-parse','HEAD')
    old={e:dict(passages=1,commit=c1) for e in full}
    inc=current_commits(str(r),old,c1)
    assert inc=={'aaaaaaaaaaaa':c1,'bbbbbbbbbbbb':c2}
    assert compute_changes(old,inc)['changed']==['bbbbbbbbbbbb']
