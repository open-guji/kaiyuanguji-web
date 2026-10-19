"""生成 fulltext/charmap.json：把全站异体字表并进全文检索的归一表（GUJI-243 语义测试发现的缺口）。

输入：
  --base      现有 charmap（繁→简一字对一字，默认 fulltext/charmap.json）
  --variants  全站异体字表 indexer/lib/variant-chars.json（异体→正字，Meili 书名搜索在用）
  --extra     全文另需的异体 fulltext/variants-extra.json（语义测试发现的缺口补这里；_ 开头的键是说明）
做法：两张表的每一对都当成"同一个字"，并查集求等价类；每类选一个代表字，其余成员都映射到它。
  代表字：从类里各成员按旧表归一后的字中选：先取异体表正字的旧归一（如 擥→攬→揽 取「揽」），再优先基本区汉字，
  再取被最多成员指向的，最后按码位。
  这样旧表已经统一的类代表字不变（简体），只是把异体并进来。
输出一字对一字、幂等（代表字不再映射）。用法：python3 build/gen_charmap.py [--check]
--check：只比对、不写；生成结果与现有 charmap.json 不同则退出 1（CI 用）。
"""
import argparse
import collections
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
FT = os.path.dirname(HERE)
REPO = os.path.dirname(FT)


def build(base, variants):
    par = {}

    def find(x):
        par.setdefault(x, x)
        while par[x] != x:
            par[x] = par[par[x]]
            x = par[x]
        return x

    def union(a, b):
        ra, rb = find(a), find(b)
        if ra != rb:
            par[max(ra, rb)] = min(ra, rb)

    for a, b in list(base.items()) + list(variants.items()):
        if len(a) != 1 or len(b) != 1:
            raise ValueError(f'不是一字对一字：{a!r}→{b!r}')
        union(a, b)
    old = lambda c: base.get(c, c)  # noqa: E731
    classes = collections.defaultdict(list)
    for x in list(par):
        classes[find(x)].append(x)
    preferred = {old(b) for b in variants.values()}
    out = {}
    for members in classes.values():
        votes = collections.Counter(old(x) for x in members)
        rep = max(votes, key=lambda r: (r in preferred, '\u4e00' <= r <= '\u9fff', votes[r], -ord(r)))
        for x in members:
            if x != rep:
                out[x] = rep
    return dict(sorted(out.items()))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--base', default=os.path.join(FT, 'charmap.json'))
    ap.add_argument('--variants', default=os.path.join(REPO, 'indexer', 'lib', 'variant-chars.json'))
    ap.add_argument('--extra', default=os.path.join(FT, 'variants-extra.json'))
    ap.add_argument('--out', default=os.path.join(FT, 'charmap.json'))
    ap.add_argument('--check', action='store_true')
    a = ap.parse_args()
    base = json.load(open(a.base, encoding='utf-8'))
    variants = json.load(open(a.variants, encoding='utf-8'))
    if a.extra and os.path.exists(a.extra):
        extra = {k: v for k, v in json.load(open(a.extra, encoding='utf-8')).items() if not k.startswith('_')}
        variants = {**variants, **extra}
    new = build(base, variants)
    if a.check:
        cur = json.load(open(a.out, encoding='utf-8'))
        if cur != new:
            print(f'charmap.json 不是最新：现有 {len(cur)} 条，生成 {len(new)} 条；跑 python3 build/gen_charmap.py 更新', file=sys.stderr)
            sys.exit(1)
        print(f'charmap.json 是最新（{len(new)} 条）')
        return
    with open(a.out, 'w', encoding='utf-8') as f:
        json.dump(new, f, ensure_ascii=False, separators=(',', ':'))
    print(f'写出 {a.out}：{len(new)} 条（旧 {len(base)} 条，异体表 {len(variants)} 条）')


if __name__ == '__main__':
    main()
