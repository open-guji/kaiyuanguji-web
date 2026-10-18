#!/usr/bin/env python3
"""rotate.sh 的 manifest 校验助手（只用标准库）。

  manifest_check.py validate MANIFEST [--current MANIFEST] [--text-dir DIR]
  manifest_check.py field MANIFEST NAME
  manifest_check.py verify-files MANIFEST RELEASE_DIR
  manifest_check.py latest-urls LATEST_JSON LATEST_URL   打印「stamp 包URL manifestURL」（一行，空格分隔）

validate 的问题逐行打印到 stdout，有问题退出码 1。
manifest 字段见 fulltext/docs/design.md；rotate 依赖：schemaVersion、stamp、createdAtEpoch、bookTextCommit、
indexBytes、books、passages、files{bytes,sha256}。
"""
import hashlib
import json
import os
import re
import subprocess
import sys


def load(p):
    with open(p, encoding='utf-8') as f:
        return json.load(f)


def problems(m, cur=None, text_dir=None):
    p = []
    if not isinstance(m, dict):
        return ['manifest 不是对象']
    if m.get('schemaVersion') != 2:
        p.append(f"schemaVersion={m.get('schemaVersion')!r}，服务只认 v2 包（存原文、无 orig 字段），旧包需重建")
    if not re.fullmatch(r'\d{8}-\d{4}', str(m.get('stamp', ''))):
        p.append(f"stamp 缺失或格式不对：{m.get('stamp')!r}（应为 YYYYMMDD-HHMM）")
    if not isinstance(m.get('createdAtEpoch'), int) or m['createdAtEpoch'] <= 0:
        p.append('createdAtEpoch 缺失或不是正整数')
    c = m.get('bookTextCommit')
    if not isinstance(c, str) or not re.fullmatch(r'[0-9a-f]{40}', c):
        p.append(f'bookTextCommit 缺失或不是 40 位 sha：{c!r}')
    elif text_dir and os.path.isdir(text_dir):
        r = subprocess.run(['git', '-C', text_dir, 'cat-file', '-e', c + '^{commit}'],
                           capture_output=True)
        if r.returncode != 0:
            p.append(f'bookTextCommit 在 {text_dir} 里不存在（搜索机上的 book-text 还没拉到这个提交）')
    for k in ('books', 'passages', 'indexBytes'):
        if not isinstance(m.get(k), int) or m[k] <= 0:
            p.append(f'{k} 缺失或不是正整数')
    if m.get('partial'):
        p.append('manifest.partial=true（试跑产物），拒绝上线')
    files = m.get('files')
    if not isinstance(files, dict) or not files:
        p.append('files 缺失或为空')
    else:
        for name in ('boost.json', 'titles.json'):
            if name not in files:
                p.append(f'files 缺 {name}')
        if not any(n.startswith('index/') for n in files):
            p.append('files 里没有 index/ 下的文件')
        for n, v in files.items():
            if n.startswith('/') or '..' in n.split('/'):
                p.append(f'files 路径不安全：{n}')
            elif not (isinstance(v, dict) and isinstance(v.get('bytes'), int)
                      and re.fullmatch(r'[0-9a-f]{64}', str(v.get('sha256', '')))):
                p.append(f'files[{n}] 缺 bytes 或 sha256')
    if cur is not None:
        ce = cur.get('createdAtEpoch')
        if isinstance(ce, int) and isinstance(m.get('createdAtEpoch'), int) and m['createdAtEpoch'] < ce:
            p.append(f"createdAtEpoch {m['createdAtEpoch']} 早于当前生效版 {ce}（旧包，拒绝覆盖新包）")
    return p


def verify_files(m, root):
    bad = []
    for n, v in m['files'].items():
        path = os.path.join(root, n)
        if not os.path.isfile(path):
            bad.append(f'缺文件：{n}')
            continue
        if os.path.getsize(path) != v['bytes']:
            bad.append(f"大小不符：{n}（{os.path.getsize(path)} ≠ {v['bytes']}）")
            continue
        h = hashlib.sha256()
        with open(path, 'rb') as f:
            for chunk in iter(lambda: f.read(1 << 20), b''):
                h.update(chunk)
        if h.hexdigest() != v['sha256']:
            bad.append(f'sha256 不符：{n}')
    return bad


def latest_urls(latest, url):
    """latest.json（build/upload_cos.mjs 写的）里 pack／manifest 是桶内完整 key，前缀＝pack 去掉最后两段；
    桶根 URL＝latest 的 URL 去掉「<前缀>/latest.json」。"""
    pack, man, stamp = latest['pack'], latest['manifest'], latest['stamp']
    prefix = '/'.join(pack.split('/')[:-2])
    tail = f'{prefix}/latest.json'
    if not url.split('?')[0].endswith(tail):
        raise ValueError(f'URL 不以 {tail} 结尾')
    root = url.split('?')[0][:-len(tail)]
    for k in (pack, man):
        if k.startswith('/') or '..' in k.split('/') or not k.startswith(prefix + '/'):
            raise ValueError(f'key 不安全：{k}')
    if not re.fullmatch(r'\d{8}-\d{4}', str(stamp)):
        raise ValueError(f'stamp 不对：{stamp!r}')
    return stamp, root + pack, root + man


def main(argv):
    if len(argv) < 3:
        print(__doc__)
        return 2
    cmd, mpath = argv[1], argv[2]
    try:
        m = load(mpath)
    except Exception as e:  # noqa: BLE001
        print(f'读不了 {mpath}：{e}')
        return 1
    if cmd == 'validate':
        cur = text = None
        if '--current' in argv:
            try:
                cur = load(argv[argv.index('--current') + 1])
            except Exception:  # noqa: BLE001
                cur = None
        if '--text-dir' in argv:
            text = argv[argv.index('--text-dir') + 1]
        ps = problems(m, cur, text)
        print('\n'.join(ps))
        return 1 if ps else 0
    if cmd == 'field':
        print(m.get(argv[3], ''))
        return 0
    if cmd == 'latest-urls':
        try:
            print(' '.join(latest_urls(m, argv[3])))
        except (KeyError, ValueError, IndexError) as e:
            print(f'latest.json 不合格：{e}', file=sys.stderr)
            return 1
        return 0
    if cmd == 'verify-files':
        bad = verify_files(m, argv[3])
        print('\n'.join(bad))
        return 1 if bad else 0
    print(__doc__)
    return 2


if __name__ == '__main__':
    sys.exit(main(sys.argv))
