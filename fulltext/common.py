"""全文检索原型公用部分：字级归一、可检索字流、段落切分、命中回映。"""
import json,os,re
HERE=os.path.dirname(os.path.abspath(__file__))
CMAP=json.load(open(os.path.join(HERE,'charmap.json')))
HAN=re.compile(r'[㐀-䶿一-鿿豈-﫿\U00020000-\U0003134f]')
# 组字式／阙文：整体算一个字位，用占位符 〓 进字流（不与任何查询字相等，又不让短语跨过它）
ZI=re.compile(r':zi\[[^\]]*\]|\[\[[^\]]*\]\]|\[[^\[\]\s]{1,12}[*/][^\[\]\s]{1,12}\]|\{[^{}\s]{2,6}\}|\[[0-9A-F]{4,5}\]')
PH='〓'
def norm_char(c): return CMAP.get(c,c)
_CLS={}
def _char_class(c):
    """单字分类：(0,None) 跳过；(1,norm) 汉字／□／〇，orig＝c；(2,lower) ASCII 字母数字。与字符上下文无关，故可按字记忆。"""
    r=_CLS.get(c)
    if r is None:
        if 0xD800<=ord(c)<=0xDFFF: r=(0,None)
        elif HAN.match(c) or c=='□' or c=='〇': r=(1,norm_char(c))
        elif c.isascii() and c.isalnum(): r=(2,c.lower())
        else: r=(0,None)
        _CLS[c]=r
    return r
def stream(raw):
    """raw → (orig_chars, norm_chars, offsets)；offsets[i] = 第 i 个可检索字元在 raw 里的起点（字符下标）。
    归一是一字对一字，所以 orig 与 norm 等长、下标一一对应。"""
    o=[];n=[];off=[]
    i=0;L=len(raw)
    while i<L:
        c=raw[i]
        if c in ':[{':
            m=ZI.match(raw,i)
            if m:
                o.append(PH);n.append(PH);off.append(i);i=m.end();continue
        k,v=_char_class(c)
        if k==1: o.append(c);n.append(v);off.append(i)
        elif k==2: o.append(v);n.append(v);off.append(i)
        i+=1
    return o,n,off
_DROP=re.compile('[^'+HAN.pattern[1:-1]+'□〇0-9A-Za-z\x00]+')   # 与 HAN 同一组码段，取反
def orig_text(raw):
    """''.join(stream(raw)[0]) 的快速版（正则在 C 里跑，约快一个数量级），exact 模式逐段筛原字用。
    组字式先换成 \x00 占位、删掉其余不可检索字符，再把占位换回 PH；原文自带 \x00 时退回 stream()。"""
    if '\x00' in raw: return ''.join(stream(raw)[0])
    t=_DROP.sub('',ZI.sub('\x00',raw))
    return t.lower().replace('\x00',PH)
def query_stream(q):
    o,n,_=stream(q); return ''.join(o),''.join(n)
TARGET=600; MAXLEN=1200
def passages(md):
    """按行（段落）切，凑到约 600 个可检索字一段；超长段在句号处断开。返回 [(start,end,heading)]。"""
    out=[];heading='';cur_s=None;cur_len=0;pos=0
    def flush(end):
        nonlocal cur_s,cur_len
        if cur_s is not None and cur_len>0: out.append((cur_s,end,heading))
        cur_s=None;cur_len=0
    for line in md.splitlines(keepends=True):
        ls,le=pos,pos+len(line);pos=le
        t=line.strip()
        if not t: continue
        if t.startswith('#'):
            flush(ls); heading=t.lstrip('#').strip()[:60]
            cur_s=ls;cur_len=len(stream(line)[0]);flush(le);continue
        n=len(stream(line)[0])
        if n>MAXLEN:
            flush(ls)
            # 句号处切（逐句累加，避免整行反复重算）
            seg_s=ls;acc=0;prev=0
            for m in re.finditer(r'[。！？；]',line):
                acc+=len(stream(line[prev:m.end()])[0]);prev=m.end()
                if acc>=TARGET:
                    out.append((seg_s,ls+m.end(),heading));seg_s=ls+m.end();acc=0
            # 剩下的尾巴（含无句号的超长段）：按字数硬切
            tail=md[seg_s:le];o,_,off=stream(tail)
            k=0
            while k<len(o):
                j=min(k+MAXLEN,len(o))
                a=seg_s+off[k]; b=seg_s+(off[j] if j<len(o) else len(tail))
                out.append((a,b,heading)); k=j
            continue
        if cur_s is None: cur_s=ls
        cur_len+=n
        if cur_len>=TARGET: flush(le)
    flush(pos)
    return out
def locate(raw,q_stream,field='norm'):
    """在一段 raw 里找查询字流的全部出现，返回 [(raw_start,raw_end)]。"""
    o,n,off=stream(raw); s=''.join(n if field=='norm' else o)
    res=[];i=s.find(q_stream)
    while i>=0:
        j=i+len(q_stream)-1
        res.append((off[i],off[j]+1)); i=s.find(q_stream,i+1)
    return res
