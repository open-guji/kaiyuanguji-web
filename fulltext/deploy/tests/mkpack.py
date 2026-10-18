#!/usr/bin/env python3
"""造假 release：mkpack.py DIR STAMP EPOCH [--bad-index] [--flaky] [--bad-sha] [--no-commit]"""
import hashlib
import json
import os
import sys

d, stamp, epoch = sys.argv[1], sys.argv[2], int(sys.argv[3])
flags = set(sys.argv[4:])
os.makedirs(os.path.join(d, 'index'), exist_ok=True)
files = {'boost.json': b'{}', 'titles.json': b'{"a":"b"}', 'index/seg.idx': b'x' * 4096}
if '--bad-index' not in flags:
    files['index/OK'] = b'1'
if '--flaky' in flags:
    files['index/FLAKY'] = b'1'
m = {'stamp': stamp, 'createdAtEpoch': epoch, 'bookTextCommit': 'a' * 40, 'books': 1, 'passages': 10,
     'indexBytes': sum(len(v) for v in files.values()), 'files': {}}
for n, data in files.items():
    with open(os.path.join(d, n), 'wb') as f:
        f.write(data)
    sha = hashlib.sha256(data).hexdigest()
    m['files'][n] = {'bytes': len(data), 'sha256': ('0' * 64) if '--bad-sha' in flags else sha}
if '--no-commit' in flags:
    del m['bookTextCommit']
with open(os.path.join(d, 'manifest.json'), 'w') as f:
    json.dump(m, f)
