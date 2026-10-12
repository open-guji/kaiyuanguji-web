#!/usr/bin/env bash
# 新旧逐文档对比（overview#561）。用法：ops/compare-old-new-docs.sh <旧版 commit> <工作目录> [--limit N] [--only works,juans,...]
# 前置：DRAFT_DIR PRODUCTION_DIR TEXT_DIR BOOK_INDEX_DERIVED_DIR 已设（派生目录含 SOURCE_COMMIT）；indexer/ 已 npm ci。
# 旧侧：取旧 commit 的 indexer/，把 meiliRequest 换成"截获文档到 <工作目录>/old"的假实现（不连 Meili）；新侧：render-docs。
set -euo pipefail
OLD_COMMIT=$1; W=$(realpath -m "$2"); shift 2
HERE=$(cd "$(dirname "$0")/.." && pwd)
mkdir -p "$W"; rm -rf "$W/oldsrc" "$W/old" "$W/new"
git -C "$HERE" archive "$OLD_COMMIT" indexer | (mkdir -p "$W/oldsrc" && tar x -C "$W/oldsrc")
ln -sfn "$HERE/indexer/node_modules" "$W/oldsrc/indexer/node_modules"
python3 - "$W/oldsrc/indexer/full-reindex.mjs" <<'PY'
import sys
p=sys.argv[1]; s=open(p).read()
i=s.index('async function meiliRequest'); j=s.index('async function waitForTask')
fake='''import { appendFileSync, mkdirSync as _mk } from 'node:fs';
const CAP = process.env.CAPTURE_DIR; _mk(CAP, { recursive: true });
async function meiliRequest(method, path, body) {
    const m = path.match(/^\\/indexes\\/([^/]+)\\/documents$/);
    if (method === 'POST' && m) { appendFileSync(`${CAP}/${m[1].replace(/_tmp$/, '')}.jsonl`, body.map(d => JSON.stringify(d)).join('\\n') + '\\n'); return { taskUid: 1 }; }
    if (method === 'GET' && path.startsWith('/tasks/')) return { status: 'succeeded' };
    if (/\\/stats$/.test(path)) return { numberOfDocuments: 0, estimatedTotalHits: 1e9 };
    if (path.includes('/search')) return { estimatedTotalHits: 1e9, hits: [] };
    return { taskUid: 1, status: 'succeeded', pagination: {}, searchableAttributes: [], filterableAttributes: [] };
}

'''
open(p,'w').write(s[:i]+fake+s[j:])
PY
export MEILI_KEY=x MEILI_URL=http://127.0.0.1:1 INDEXER_LOCK="$W/lock"
# 旧版 full-reindex 收尾会因假 Meili 报"自检未通过/final stats"，无妨：文档在 push 时已截获
(cd "$W/oldsrc/indexer" && CAPTURE_DIR="$W/old" node full-reindex.mjs --allow-shrink "$@" > "$W/old.log" 2>&1) || true
node "$HERE/indexer/render-docs.mjs" --out "$W/new" "$@" | tail -2
node "$HERE/ops/compare-docs.mjs" "$W/old" "$W/new/docs" --json "$W/report.json"
